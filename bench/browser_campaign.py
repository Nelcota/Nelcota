"""Owned verified-HTTPS browser/SDK campaign with two real auth consumers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

from browser_runtime import prepare
from browser_diagnostics import collect as failure_diagnostics
from browser_auth import PROFILE as AUTH_PROFILE, complete as auth_pressure_complete, failure_receipt
from campaign import ResourceCoverage, docker, effective_cpus, owns_listener, validate_disk_headroom, validate_storage_filesystem
from disk_usage import host as disk_usage, container as container_disk_usage
from host_resources import owned_cgroup_snapshot, require_no_oom, snapshot as host_snapshot
from ingress import Ingress
from observations import generator_observation, inspect_container
from ownership import LABEL, LOG_PROFILE, OwnedDocker
from projects import Project
from watchdog import atomic_json, cleanup, host_reserves, process_identity, stop_generator


def campaign(args):
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError('Preserve prior browser evidence')
    output.mkdir(parents=True, exist_ok=True)
    cpus = sorted(os.sched_getaffinity(0))
    minimum_slots = 5
    observer_affinity = cpus
    if args.four_cpu_actions:
        if os.getuid() == 0 or os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
            raise RuntimeError('The explicit four-slot browser profile requires a nonroot disposable Actions VM')
        minimum_slots = 4
        observer_affinity = cpus[3:4]
    if (not args.four_cpu_actions and os.getuid() != 1000) or len(cpus) < minimum_slots or effective_cpus(cpus) < 4 or host_reserves(output):
        raise RuntimeError('Browser profile needs its declared affinity slots, four effective CPUs and reserves')
    if args.four_cpu_actions:
        os.sched_setaffinity(0, {cpus[3]})
    validate_disk_headroom(output, 512, startup_mib=4096)
    identity = 'nelcota-browser-'+secrets.token_hex(16)
    owned = OwnedDocker(identity, docker)
    directory = Path(tempfile.mkdtemp(prefix='fixture-', dir=output))
    filesystem = subprocess.check_output(['stat', '-f', '-c', '%T', str(directory)], text=True).strip()
    validate_storage_filesystem('disk', filesystem)
    source = Project(identity, 0, 2, args.binary.resolve(), directory, cpus)
    consumer = Project(identity, 1, 2, args.binary.resolve(), directory, cpus)
    ingress = Ingress(identity, directory, owned, cpus[3])
    generator = identity+'-load'
    manifest = {'identity':identity, 'output':str(output), 'reserve_path':str(output), 'pid':os.getpid(),
                'process_identity':process_identity(os.getpid()), 'started_monotonic':time.monotonic(),
                'maximum_seconds':3600, 'preparation_seconds':900,
                'containers':[source.pg, source.app, consumer.app, ingress.name, generator], 'volumes':[source.volume]}
    atomic_json(output/'ownership.json', manifest)
    phase = 'preparation'
    resource_at = manifest['started_monotonic']
    active = None
    stop, critical, heartbeat_stop = threading.Event(), threading.Event(), threading.Event()
    violations = []
    coverage = ResourceCoverage()
    status = 'failed'
    checkpoint = 'runtime-prepare'
    failure = None
    sampler = watchdog = None
    previous = signal.getsignal(signal.SIGTERM)
    def terminate(signum, frame):
        critical.set()
        stop_generator(manifest)
        raise RuntimeError('Browser campaign terminated by watchdog or owner')
    signal.signal(signal.SIGTERM, terminate)
    def heartbeat():
        while not heartbeat_stop.is_set():
            atomic_json(output/'heartbeat.json', {'phase':phase, 'monotonic':time.monotonic(), 'resource_monotonic':resource_at})
            heartbeat_stop.wait(2)
    heart = threading.Thread(target=heartbeat, daemon=True)
    heart.start()
    try:
        watchdog = subprocess.Popen([sys.executable, str(Path(__file__).with_name('watchdog.py')), str(output/'ownership.json')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        runtime = directory/'runtime'
        runtime_profile = prepare(runtime, args.sdk, args.chrome_executable)
        shutil.copyfile(runtime/'runtime-manifest.json', output/'runtime-manifest.private.json')
        checkpoint = 'source-create'
        source.create()
        checkpoint = 'source-restart'
        source.environment['NELCOTA_TRUST_PROXY'] = 'true'
        owned('rm', '-f', source.app)
        source.start_app()
        checkpoint = 'consumer-start'
        consumer.storage = source.storage
        consumer.environment = {**source.environment, 'NELCOTA_LISTEN':consumer.base.removeprefix('http://')}
        consumer.start_app()
        checkpoint = 'fixture-schema'
        source.sql("CREATE TABLE public.bench_alternate(id integer PRIMARY KEY,name text,stock integer); INSERT INTO public.bench_alternate SELECT i,'alternate:'||i,i%50 FROM generate_series(1,1000)i; GRANT SELECT ON public.bench_alternate TO anon,authenticated,service_role; ANALYZE public.bench_alternate; NOTIFY nelcota,'reload schema';")
        checkpoint = 'proxy-start'
        proxy_profile = ingress.start([source], output)
        original = (ingress.directory/'etc/Caddyfile').read_text()
        needle = f'reverse_proxy 127.0.0.1:{source.port}'
        if original.count(needle) != 1:
            raise RuntimeError('Unexpected owned proxy configuration')
        replacement = f'''@auth_data path /auth/* /rest/*
 reverse_proxy @auth_data 127.0.0.1:{source.port} 127.0.0.1:{consumer.port} {{
  lb_policy round_robin
  header_down X-G05-Upstream {{http.reverse_proxy.upstream.hostport}}
 }}
 reverse_proxy 127.0.0.1:{source.port}'''
        configuration = original.replace(needle, replacement)
        checkpoint = 'proxy-reconfigure'
        config = ingress.directory/'etc/auth-consumers.Caddyfile'
        config.write_text(configuration)
        config.chmod(0o444)
        owned('exec', ingress.name, 'caddy', 'reload', '--config', '/etc/caddy/auth-consumers.Caddyfile', '--adapter', 'caddyfile', '--address', 'unix//config/admin.sock')
        image = json.loads(owned('image', 'inspect', 'ubuntu:24.04'))[0]
        fixture = {'base':source.fixture['base'], 'email':source.email, 'admin_email':source.admin_email,
                   'password':source.password, 'user':source.fixture['user'], 'label':source.label,
                   'session_seconds':args.session_seconds, 'storage_key':'g05.'+secrets.token_hex(16),
                   'upstreams':[f'127.0.0.1:{source.port}', f'127.0.0.1:{consumer.port}']}
        with args.binary.open('rb') as stream:
            binary_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        fixture['auth_pressure'] = args.auth_pressure
        profile = {'scope':'owned live browser panel and built SDK, shared database with two real auth consumers; no public WAN/controller certification',
                   'binary_sha256':binary_digest, 'runtime':runtime_profile, 'proxy':proxy_profile,
                   'proxy_config_sha256':hashlib.sha256(configuration.encode()).hexdigest(),
                   'auth_consumers':2, 'app_aggregate_cpus':1, 'postgres_cpus':.5, 'browser_cpus':1,
                   'auth_pressure_enabled':args.auth_pressure,
                   'auth_pressure_profile':AUTH_PROFILE,
                   'observer_shares_proxy_CPU_explicitly':args.four_cpu_actions,
                   'observer_CPU_affinity':observer_affinity,
                   'app_memory_mib_each':128, 'postgres_memory_mib':256, 'browser_memory_mib':1536,
                   'browser_pids_limit':256, 'browser_home_disk_mib_each':256, 'database_disk_mib':512,
                   'browser_fixture_disk_mib':3072,
                   'session_seconds':args.session_seconds, 'tabs':3, 'pressure_rest_cycles':5,
                   'navigation_interval_minimum_ms':100, 'maximum_API_requests':12000, 'maximum_API_requests_per_second':64,
                   'SDK_additional_read_retries':2, 'SDK_mutation_retries':0,
                   'maximum_decoded_network_mib':128, 'feedback_p95_ms':1000,
                   'maximum_heap_growth_per_page_mib':8, 'maximum_node_growth_per_page':250, 'maximum_listener_growth_per_page':32,
                   'private_PID_namespace':True, 'browser_OS_sandbox':'outer owned nonroot container, all capabilities dropped, read-only root, no-new-privileges; Chromium sandbox disabled inside it',
                   'maximum_private_driver_log_bytes':16777216,
                   'TLS_verification':True, 'real_home_mounted':False, 'container_log_profile':LOG_PROFILE,
                   'image_digests':image['RepoDigests'], 'certifies_g05':False}
        atomic_json(output/'manifest.json', profile)
        components = [source.app, consumer.app, source.pg, ingress.name]
        states = json.loads(owned('inspect', *components))
        identities = {state['Name']:state['State']['Pid'] for state in states}
        resource_began = time.monotonic()
        resource_at = resource_began
        def sample():
            nonlocal resource_at
            while not stop.is_set():
                cycle = time.monotonic()
                probe = 'host-reserves'
                try:
                    reason = host_reserves(output)
                    if reason:
                        raise RuntimeError(reason)
                    probe = 'components'
                    states = json.loads(owned('inspect', *components))
                    if any(not item['State']['Running'] or item['State']['OOMKilled'] or item['State']['Pid'] != identities[item['Name']] for item in states):
                        raise RuntimeError('Unexpected browser target restart or OOM')
                    probe = 'cgroups'
                    cgroups = {name:owned_cgroup_snapshot(owned, name) for name in components}
                    for value in cgroups.values():
                        require_no_oom(value['memory.events'])
                    probe = 'driver'
                    generation = generator_observation(active, lambda:active)
                    if generation and generation.get('host_pid') and generation.get('pid_starttime'):
                        atomic_json(output/'generator-process.json', {'identity':identity, 'pid':generation['host_pid'], 'process_identity':generation['pid_starttime'], 'container_id':generation['container_id']})
                        context = active
                        try:
                            observed = owned_cgroup_snapshot(owned, generation['container_id'])
                        except (RuntimeError, ValueError):
                            current = inspect_container(generation['container_id'])
                            if context is active and context is not None and context['process'].poll() is None and current and current['State']['Running']:
                                raise
                            generation = None
                        if generation:
                            require_no_oom(observed['memory.events'])
                            cgroups['browser'] = observed
                    probe = 'database'
                    database = json.loads(source.sql("SELECT json_build_object('connections',count(*),'stuck_idle_transactions',count(*) FILTER(WHERE state='idle in transaction' AND clock_timestamp()-state_change>interval '5 seconds'),'waiting_locks',count(*) FILTER(WHERE wait_event_type='Lock')) FROM pg_stat_activity WHERE backend_type='client backend'"))
                    if database['connections'] > 32 or database['stuck_idle_transactions']:
                        raise RuntimeError('Browser database owner budget')
                    probe = 'disk'
                    database_disk = container_disk_usage(owned, source.pg, '/var/lib/postgresql/data')
                    if database_disk['value'] > 512:
                        raise RuntimeError('Browser database disk budget')
                    home_disk = {home.name:disk_usage(home) for home in directory.glob('*-home')}
                    if any(value['value'] > 256 for value in home_disk.values()):
                        raise RuntimeError('Browser home disk budget')
                    allocated = disk_usage(directory)
                    if allocated['value'] > 3072:
                        raise RuntimeError('Browser fixture disk budget')
                    probe = 'append'
                    resource_at = time.monotonic()
                    coverage.observe(resource_at-resource_began)
                    with (output/'resources.jsonl').open('a') as stream:
                        stream.write(json.dumps({'phase':phase, 'monotonic':resource_at, 'component_cgroups':cgroups,
                                    'generator':generation, 'database':database, 'database_disk_mib':database_disk,
                                    'browser_home_disk_mib':home_disk, 'allocated_disk_mib':allocated,
                                    'host':host_snapshot(cpus)})+'\n')
                    atomic_json(output/'checkpoint.json', {'phase':phase, 'monotonic':resource_at, 'resource_observations':coverage.count})
                except Exception as error:
                    violations.append({'phase':phase, 'probe':probe, 'type':type(error).__name__})
                    critical.set()
                    stop_generator(manifest)
                    return
                stop.wait(max(0,5-(time.monotonic()-cycle)))
        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()
        def browser_run(label, trusted):
            nonlocal phase, active
            phase = label
            evidence = output/label
            evidence.mkdir()
            home = directory/(label+'-home')
            nss = home/'.pki/nssdb'
            nss.mkdir(parents=True)
            subprocess.run(['certutil', '-N', '-d', 'sql:'+str(nss), '--empty-password'], check=True, capture_output=True, timeout=15)
            if trusted:
                ca = ingress.directory/'data/caddy/pki/authorities/local/root.crt'
                subprocess.run(['certutil', '-A', '-d', 'sql:'+str(nss), '-n', 'Nelcota G05 local fixture', '-t', 'C,,', '-i', str(ca)], check=True, capture_output=True, timeout=15)
            case = {**fixture, 'untrusted_control':not trusted}
            input_file = directory/(label+'-input.json')
            atomic_json(input_file, case)
            input_file.chmod(0o600)
            command = ['docker', 'run', '--name', generator, '--label', LABEL+'='+identity,
                       '--network', 'host', '--cpus', '1', '--cpuset-cpus', str(cpus[2]),
                       '--memory', '1536m', '--memory-swap', '1536m', '--pids-limit', '256', '--shm-size', '128m',
                       '--user', f'{os.getuid()}:{os.getgid()}', '--cap-drop', 'ALL', '--read-only', '--security-opt', 'no-new-privileges',
                       '--log-driver', 'local', '--log-opt', 'max-size=8m', '--log-opt', 'max-file=2',
                       '--tmpfs', f'/tmp:rw,noexec,nosuid,size=128m,uid={os.getuid()},gid={os.getgid()}',
                       '--mount', f'type=bind,source={runtime},target=/runtime,readonly',
                       '--mount', f'type=bind,source={runtime/"libs"},target=/usr/lib/x86_64-linux-gnu,readonly',
                       '--mount', f'type=bind,source={Path(__file__).with_name("browser_driver.py")},target=/driver.py,readonly',
                       '--mount', f'type=bind,source={Path(__file__).with_name("browser_auth.js")},target=/auth-pressure.js,readonly',
                       '--mount', f'type=bind,source={Path(__file__).with_name("browser_auth.py")},target=/auth-evidence.py,readonly',
                       '--mount', f'type=bind,source={input_file},target=/fixture.json,readonly',
                       '--mount', f'type=bind,source={home},target=/home/ubuntu',
                       '--mount', f'type=bind,source={evidence},target=/evidence',
                       '-e', 'HOME=/home/ubuntu', '-e', 'XDG_CONFIG_HOME=/home/ubuntu/.config', '-e', 'XDG_CACHE_HOME=/home/ubuntu/.cache',
                       '-e', 'FONTCONFIG_FILE=/runtime/fonts.conf', '-e', 'LANG=C.UTF-8',
                       '-e', 'DEBUG=pw:browser',
                       image['Id'], '/runtime/python/bin/python3', '-I', '/runtime/browser_entry.py']
            limiter = shutil.which('prlimit')
            if limiter is None:
                raise RuntimeError('Bounded private browser diagnostics require prlimit')
            command = [limiter, '--fsize=16777216:16777216', '--', *command]
            started = time.monotonic()
            with (output/(label+'.log')).open('w') as log:
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
                active = {'process':process, 'name':generator, 'identity':identity, 'phase':label, 'started':started}
                released = False
                try:
                    while process.poll() is None:
                        if critical.wait(.25) or watchdog.poll() is not None or time.monotonic()-started > args.session_seconds+180:
                            stop_generator(manifest)
                            raise RuntimeError('Browser resource, observer or duration gate')
                        if (evidence/'driver-ready').exists() and not (evidence/'driver-start').exists():
                            state = json.loads(owned('inspect', generator))[0]
                            if state['HostConfig']['PidMode']:
                                raise RuntimeError('Browser traffic must use a private PID namespace')
                            pid = state['State']['Pid']
                            atomic_json(output/'generator-process.json', {'identity':identity, 'pid':pid, 'process_identity':process_identity(pid), 'container_id':state['Id']})
                            (evidence/'driver-start').touch()
                        if (evidence/'driver-finished').exists() and not released:
                            ending = owned_cgroup_snapshot(owned, generator)
                            require_no_oom(ending['memory.events'])
                            atomic_json(evidence/'generator-after-close.json', ending)
                            (evidence/'driver-release').touch()
                            released = True
                finally:
                    active = None
                    if process.poll() is None:
                        stop_generator(manifest)
                        owned('rm', '-f', generator)
                        process.wait(timeout=20)
            state = json.loads(owned('inspect', generator))[0]['State']
            if process.returncode or state['OOMKilled'] or not released:
                raise RuntimeError('Live browser driver did not complete its owned lifecycle')
            result = json.loads((evidence/'browser-result.json').read_text())
            if result['status'] != 'passed':
                raise RuntimeError('Live browser correctness gates failed')
            owned('rm', '-f', generator)
            return result
        checkpoint = 'untrusted-browser'
        negative = browser_run('untrusted-ca', False)
        checkpoint = 'live-browser'
        positive = browser_run('live-panel-SDK', True)
        checkpoint = 'auth-census'
        if args.auth_pressure:
            positive['auth_pressure'] = auth_pressure_complete(positive['auth_pressure'])
            census = json.loads(source.sql("SELECT json_build_object('created_users',count(DISTINCT u.id),'unrevoked_sessions',count(s.id) FILTER(WHERE s.revoked_at IS NULL)) FROM auth.users u LEFT JOIN auth.sessions s ON s.user_id=u.id WHERE u.email LIKE 'g05-%@example.test'"))
            if census != {'created_users':40, 'unrevoked_sessions':0}:
                raise RuntimeError('Raw browser auth pressure row/session accounting failed')
            positive['auth_pressure_census'] = census
            atomic_json(output/'auth-pressure-census.json', census)
        atomic_json(output/'browser-invariants.json', {'untrusted_control':negative, 'live':positive})
        checkpoint = 'final-resource-check'
        stop.set()
        sampler.join(timeout=30)
        violations.extend(coverage.violations(time.monotonic()-resource_began))
        if sampler.is_alive() or critical.is_set() or violations:
            raise RuntimeError('Browser resource observation incomplete')
        status = 'passed'
        checkpoint = 'done'
    except Exception as error:
        failure = failure_receipt(checkpoint, error)
        atomic_json(output/'browser-failure.json', failure)
        try:
            diagnostic = failure_diagnostics(output, source, consumer, owned, generator, violations)
            atomic_json(output/'browser-diagnostics.json', diagnostic)
        except Exception:
            atomic_json(output/'browser-diagnostics-unavailable.json', {'available':False})
        raise
    finally:
        phase = 'teardown'
        atomic_json(output/'heartbeat.json', {'phase':phase, 'monotonic':time.monotonic(), 'resource_monotonic':resource_at})
        stop.set()
        if sampler is not None:
            sampler.join(timeout=30)
        atomic_json(output/'resource-violations.json', violations)
        cleanup(manifest)
        clean = not owned('ps', '-aq', '--filter', 'label='+LABEL+'='+identity) and not owned('volume', 'ls', '-q', '--filter', 'label='+LABEL+'='+identity)
        shutil.rmtree(directory)
        clean = clean and not directory.exists()
        if clean:
            (output/'watchdog-disarmed').touch()
        heartbeat_stop.set()
        heart.join(timeout=3)
        if watchdog is not None:
            watchdog.wait(timeout=15)
        signal.signal(signal.SIGTERM, previous)
        if not clean:
            status = 'failed'
        atomic_json(output/'completion.json', {'status':status, 'cleanup_confirmed':clean, 'resource_observations':coverage.count,
                    'failure':failure,
                    'scope':'live browser correctness and lifecycle only; not G05 endurance certification', 'certifies_g05':False})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sdk', type=Path, required=True)
    parser.add_argument('--session-seconds', type=int, default=1080)
    parser.add_argument('--auth-pressure', action='store_true')
    parser.add_argument('--four-cpu-actions', action='store_true')
    parser.add_argument('--chrome-executable', type=Path)
    args = parser.parse_args()
    if not args.binary.is_file() or not 900 <= args.session_seconds <= 1500:
        parser.error('Browser needs an existing binary and a 900..1500-second real session observation')
    campaign(args)
