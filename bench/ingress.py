"""Owned real Caddy with verified local HTTPS; no public DNS/ACME claim."""
import errno
import hashlib
import json
import os
from pathlib import Path
import ssl
import time
import urllib.error
import urllib.request

from campaign import free_port, owns_listener
from watchdog import LABEL, atomic_json
from disk_usage import host as host_disk_usage

CADDY = 'caddy:2-alpine'


def configuration(frontends, upstreams):
    if not frontends or len(frontends) != len(upstreams) or len(frontends) > 10:
        raise ValueError('Caddy fixture needs one frontend per owned project')
    if any(isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535 for port in [*frontends, *upstreams]):
        raise ValueError('Caddy fixture accepts only unprivileged loopback ports')
    if len(set(frontends)) != len(frontends) or len(set(upstreams)) != len(upstreams) or set(frontends) & set(upstreams):
        raise ValueError('Caddy frontend ports must be distinct from all backends')
    blocks = ['{\n admin unix//config/admin.sock\n auto_https disable_redirects\n skip_install_trust\n}\n']
    for port, upstream in zip(frontends, upstreams):
        blocks.append(f'https://localhost:{port} {{\n bind 127.0.0.1\n tls internal\n @compressible not path /storage/*\n encode @compressible zstd gzip\n reverse_proxy 127.0.0.1:{upstream}\n header {{\n  -Server\n  Strict-Transport-Security "max-age=31536000"\n  X-Content-Type-Options "nosniff"\n }}\n}}\n')
    return '\n'.join(blocks)


class Ingress:
    def __init__(self, identity, directory, owned, cpu):
        self.identity = identity
        self.directory = Path(directory) / 'caddy'
        self.owned = owned
        self.cpu = cpu
        self.name = identity + '-proxy'
        self.bundle = self.directory / 'verified-ca.pem'
        self.frontends = []

    def startup_failure(self, output, reason):
        evidence = {'reason': reason}
        try:
            state = json.loads(self.owned('inspect', self.name))[0]['State']
            evidence['state'] = {key: state[key] for key in ['Running', 'ExitCode', 'OOMKilled', 'StartedAt', 'FinishedAt']}
            logs = self.owned('logs', '--tail', '100', self.name, include_stderr=True)
            (Path(output)/'proxy-startup.log').write_text(logs[-512*1024:])
        except Exception as error:
            evidence['diagnostic_error_type'] = type(error).__name__
        atomic_json(Path(output)/'proxy-startup-failure.json', evidence)
        raise RuntimeError('Owned Caddy startup failed: '+reason)

    def start(self, projects, output):
        image = json.loads(self.owned('image', 'inspect', CADDY))[0]
        self.directory.mkdir()
        for name in ['data', 'config', 'etc', 'bin']:
            (self.directory / name).mkdir()
        # The image's executable has cap_net_bind_service. Executing that file
        # with an empty capability bounding set fails even on high ports. Copy
        # bytes without xattrs; keep cap-drop ALL and no-new-privileges in place.
        source_digest = self.owned('run', '--rm', '--name', self.name, '--label', LABEL+'='+self.identity,
                                  '--network', 'none', '--cpus', '.25', '--cpuset-cpus', str(self.cpu),
                                  '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '16',
                                  '--user', f'{os.getuid()}:{os.getgid()}', '--cap-drop', 'ALL',
                                  '--read-only', '--security-opt', 'no-new-privileges',
                                  '-v', str(self.directory/'bin')+':/owned-bin', '--entrypoint', '/bin/sh',
                                  image['Id'], '-c', 'sha256sum /usr/bin/caddy && cp /usr/bin/caddy /owned-bin/caddy').split()[0]
        binary = self.directory/'bin/caddy'
        if binary.is_symlink() or not 0 < binary.stat().st_size <= 96*1024*1024:
            raise RuntimeError('Owned Caddy binary exceeded its preparation boundary')
        binary_digest = hashlib.file_digest(binary.open('rb'), 'sha256').hexdigest()
        if source_digest != binary_digest:
            raise RuntimeError('Owned Caddy binary bytes differ from the immutable image')
        capabilities_present = True
        try:
            os.getxattr(binary, 'security.capability')
        except OSError as error:
            if error.errno not in (errno.ENODATA, errno.ENOTSUP):
                raise
            capabilities_present = False
        if capabilities_present:
            raise RuntimeError('Owned Caddy copy retained executable file capabilities')
        binary.chmod(0o555)
        self.frontends = [free_port() for _ in projects]
        content = configuration(self.frontends, [project.port for project in projects])
        path = self.directory / 'etc/Caddyfile'
        path.write_text(content)
        path.chmod(0o444)
        self.owned('run', '-d', '--name', self.name, '--label', LABEL+'='+self.identity,
                   '--pids-limit', '64', '--network', 'host', '--cpus', '.25', '--cpuset-cpus', str(self.cpu),
                   '--memory', '128m', '--memory-swap', '128m', '--user', f'{os.getuid()}:{os.getgid()}',
                   '--cap-drop', 'ALL', '--read-only', '--security-opt', 'no-new-privileges',
                   '--tmpfs', f'/tmp:rw,noexec,nosuid,size=16m,uid={os.getuid()},gid={os.getgid()}',
                   '-v', str(self.directory/'etc')+':/etc/caddy:ro',
                   '-v', str(binary)+':/usr/bin/caddy:ro',
                   '-v', str(self.directory/'data')+':/data', '-v', str(self.directory/'config')+':/config',
                   image['Id'], 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
        ca = self.directory / 'data/caddy/pki/authorities/local/root.crt'
        deadline = time.monotonic() + 30
        while not ca.is_file():
            if not json.loads(self.owned('inspect', self.name))[0]['State']['Running']:
                self.startup_failure(output, 'proxy_exited_before_CA_readiness')
            if time.monotonic() > deadline:
                self.startup_failure(output, 'CA_readiness_deadline')
            time.sleep(.25)
        if ca.stat().st_size > 65536:
            raise RuntimeError('Caddy CA exceeded its declared size')
        trust = Path('/etc/ssl/certs/ca-certificates.crt').read_bytes()
        self.bundle.write_bytes(trust + b'\n' + ca.read_bytes())
        self.bundle.chmod(0o444)
        context = ssl.create_default_context(cafile=str(self.bundle))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        for project, port in zip(projects, self.frontends):
            base = f'https://localhost:{port}'
            while True:
                try:
                    if not owns_listener(self.owned.require(self.name), port):
                        raise RuntimeError('Caddy listener ownership not ready')
                    with opener.open(base+'/auth/v1/.well-known/jwks.json', timeout=2) as response:
                        if response.status != 200:
                            raise RuntimeError('Caddy positive HTTPS probe failed')
                        json.loads(response.read(65536))
                    break
                except (OSError, urllib.error.URLError, RuntimeError):
                    if time.monotonic() > deadline:
                        self.startup_failure(output, 'verified_listener_readiness_deadline')
                    time.sleep(.1)
            project.fixture['base'] = base
        untrusted = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
        try:
            with untrusted.open(f'https://localhost:{self.frontends[0]}/auth/v1/.well-known/jwks.json', timeout=2):
                raise RuntimeError('Untrusted local Caddy certificate was accepted')
        except urllib.error.URLError as error:
            if not isinstance(error.reason, ssl.SSLCertVerificationError):
                raise RuntimeError('Untrusted CA control did not fail certificate verification') from None
        profile = {'kind': 'real Caddy with verified internal CA on loopback', 'cpus': .25,
                   'cpu_affinity': self.cpu, 'memory_mib': 128, 'pids_limit': 64,
                   'fixture_disk_mib': 128, 'binary_sha256': binary_digest,
                   'image_file_capabilities_removed_for_unprivileged_ports': True,
                   'image_digests': image['RepoDigests'], 'public_dns_acme_certified': False,
                   'reload_fault': 'valid configuration rejected by an occupied owned backend listener; restore and probe without process replacement'}
        atomic_json(Path(output)/'proxy.json', {**profile, 'ca_sha256': hashlib.sha256(ca.read_bytes()).hexdigest(),
                                               'config_sha256': hashlib.sha256(content.encode()).hexdigest(),
                                               'https_frontends': len(self.frontends), 'tls_verification': True,
                                               'untrusted_ca_rejected': True})
        return profile

    def reload_failure(self, projects, output):
        """Exercise a real apply failure while the original proxy serves traffic."""
        backend = projects[0]
        if not owns_listener(self.owned.require(backend.app), backend.port):
            raise RuntimeError('Reload fault requires the occupied owned backend listener')
        before = json.loads(self.owned('inspect', self.name))[0]
        content = (self.directory / 'etc/Caddyfile').read_text()
        candidate = self.directory / 'etc/rejected-reload.Caddyfile'
        candidate.write_text(content + f'\nhttps://localhost:{backend.port} {{\n bind 127.0.0.1\n tls internal\n respond "owned reload fault"\n}}\n')
        candidate.chmod(0o444)
        started = time.monotonic()
        rejected = False
        try:
            try:
                self.owned('exec', self.name, 'caddy', 'reload', '--config', '/etc/caddy/rejected-reload.Caddyfile', '--adapter', 'caddyfile', '--address', 'unix//config/admin.sock')
            except RuntimeError as error:
                reason = str(error).lower()
                if 'listen tcp' not in reason or 'address already in use' not in reason:
                    raise RuntimeError('Proxy reload failed for an unexpected reason') from None
                rejected = True
        finally:
            # Even an unexpectedly accepted candidate must not survive the probe.
            self.owned('exec', self.name, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile', '--address', 'unix//config/admin.sock', '--force')
        restored = time.monotonic()
        context = ssl.create_default_context(cafile=str(self.bundle))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
        deadline = restored + 35
        for project in projects:
            while True:
                try:
                    with opener.open(project.fixture['base']+'/rest/v1/bench_products?stock=eq.1&order=id&limit=20', timeout=2) as response:
                        rows = json.loads(response.read(65536))
                        if response.status != 200 or not isinstance(rows, list) or len(rows) != 20 or any(not isinstance(row, dict) or row.get('stock') != 1 or not str(row.get('name', '')).startswith(project.fixture['marker']) for row in rows):
                            raise RuntimeError('Proxy recovery returned invalid project data')
                    break
                except (OSError, urllib.error.URLError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Proxy recovery exceeded its declared deadline') from None
                    time.sleep(.1)
            request = urllib.request.Request(project.fixture['base']+'/rest/v1/bench_private?limit=1', headers={'Authorization': 'Bearer '+project.fixture['invalid_access']})
            try:
                with opener.open(request, timeout=2):
                    raise RuntimeError('Proxy recovery accepted an invalid credential')
            except urllib.error.HTTPError as error:
                if error.code != 401:
                    raise RuntimeError('Proxy recovery returned an unexpected rejection') from None
        after = json.loads(self.owned('inspect', self.name))[0]
        continuous = before['Id'] == after['Id'] and all(before['State'][key] == after['State'][key] for key in ['Pid', 'StartedAt'])
        if time.monotonic() > deadline:
            raise RuntimeError('Proxy recovery exceeded its declared deadline')
        result = {'expected_bind_rejection': rejected, 'good_configuration_restored': True,
                  'projects_with_positive_and_401_probes': len(projects), 'same_proxy_process': continuous,
                  'elapsed_seconds': time.monotonic()-started, 'recovery_seconds_after_restore': time.monotonic()-restored,
                  'tls_verification': True, 'public_dns_acme_certified': False}
        atomic_json(Path(output)/'proxy-reload-failure.json', result)
        if not rejected or not continuous:
            raise RuntimeError('Actual reload rejection or proxy process continuity was not demonstrated')
        return result

    def observe(self):
        value = host_disk_usage(self.directory)
        if value['value'] > 128:
            raise RuntimeError('Caddy fixture disk budget exceeded')
        return value
