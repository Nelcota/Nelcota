"""One-off P12 operator probe; imports the historical VM harness unchanged.

Only adapts the recovery command and expected stopped failed-unit state to the
new fence contract. Keeps every duration, resource limit and authorization
canary. This is not a G05 campaign or a physical power-loss certification.
"""
import http.client
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'bench'))
import native_vm
import native_pitr_reboot
from native_guest import ROOT as GUEST_ROOT, PROJECT, UNIT, require
from native_pitr_failure import PG_UNIT, fenced

ORIGINAL_RECOVER = native_pitr_reboot.recover
PROFILE = native_pitr_reboot.PROFILE
PRODUCTION = json.loads((ROOT / 'target/p12-input/manifest.json').read_text())


def safe_private(guest, name, result):
    raw = result.stdout + result.stderr
    require(len(raw) <= 65536, 'P12 private command exceeded its byte ceiling')
    path = guest.directory / name
    with path.open('xb') as stream:
        path.chmod(0o600)
        stream.write(raw)


def observe(guest, api, token):
    began = time.monotonic()
    samples = []
    while time.monotonic() - began < PROFILE['minimum_observation_seconds']:
        guest.assert_safe()
        require(len(samples) < PROFILE['maximum_samples'], 'P12 boot sample ceiling reached')
        units = native_pitr_reboot.snapshot(guest.action('resources', timeout=PROFILE['maximum_guest_resource_request_seconds']))
        reopened = False
        try:
            api.request('GET', '/rest/v1/native_probe?select=id', token=token)
            reopened = True
        except (OSError, RuntimeError, http.client.HTTPException):
            guest.assert_safe()
        samples.append({'units': units, 'authenticated_API_reopened': reopened})
        if not fenced(units) or reopened:
            break
        time.sleep(PROFILE['minimum_sample_gap_seconds'])
    elapsed = time.monotonic() - began
    passed = (2 <= len(samples) <= PROFILE['maximum_samples']
              and PROFILE['minimum_observation_seconds'] <= elapsed <= PROFILE['maximum_observation_seconds']
              and all(fenced(row['units']) and not row['authenticated_API_reopened'] for row in samples))
    # ExecStartPre deliberately fails the requested start. 'failed' with PID0
    # is stopped; no running/restarting PID or reopened API is accepted.
    value = {'profile': PROFILE, 'samples': samples, 'elapsed_seconds': elapsed,
             'unknown_state_kept_stopped_after_boot': passed,
             'operator_probe': 'P12 minimal probe: PID zero, inactive/failed, no API; original duration/resource/canary gates unchanged',
             'production_source_commit': PRODUCTION['source_commit'],
             'production_binary_sha256': PRODUCTION['binary_sha256']}
    checks = {}
    for role, unit in [('postgres', PG_UNIT), ('app', UNIT)]:
        result = guest.ssh(['sudo', '-n', 'systemctl', 'start', unit], timeout=20, check=False)
        safe_private(guest, 'manual-' + role + '.private.log', result)
        checks[role + '_systemctl_start_exit_code'] = result.returncode
        require(result.returncode != 0, 'Manual systemctl start did not reject the P12 fence')
    for label, args in [('up', ['-C', str(GUEST_ROOT), '-p', PROJECT, 'up']), ('serve', ['serve'])]:
        result = guest.ssh(['sudo', '-n', '/usr/local/bin/nelcota', *args], timeout=20, check=False)
        safe_private(guest, 'manual-' + label + '.private.log', result)
        raw = result.stdout + result.stderr
        checks['CLI_' + label + '_exit_code'] = result.returncode
        checks['CLI_' + label + '_names_fence_and_recovery'] = b'active.json' in raw and b'pitr recover --yes' in raw
        require(result.returncode != 0 and checks['CLI_' + label + '_names_fence_and_recovery'],
                'CLI start refusal must name the durable fence and exact recovery action')
    journal = guest.ssh(['sudo', '-n', 'journalctl', '-u', PG_UNIT, '-n', '30', '--no-pager', '--output=cat'], timeout=15)
    safe_private(guest, 'manual-start-journal.private.log', journal)
    checks['systemd_journal_names_fence_and_recovery'] = b'active.json' in journal.stdout and b'pitr recover --yes' in journal.stdout
    require(checks['systemd_journal_names_fence_and_recovery'], 'Missing clear systemd refusal message')
    require(fenced(native_pitr_reboot.snapshot(guest.action('resources', timeout=12))), 'Manual start reopened a fenced service')
    value['manual_start_checks'] = checks
    return value


def recover(guest, helper_command, control):
    # Mandatory boot verdict must pass before the explicit recovery can begin.
    require(control['boot_observation']['unknown_state_kept_stopped_after_boot'] is True,
            'Preserve a failed boot verdict before any explicit recovery')
    name = 'p12-recover-' + guest.identity
    arguments = ['sudo', '-n', 'systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit=' + name,
                 '--slice=g05native.slice', '--property=CPUQuota=10%', '--property=CPUQuotaPeriodSec=100ms',
                 '--property=MemoryMax=96M', '--property=MemorySwapMax=0', '--property=TasksMax=32',
                 '--property=RuntimeMaxSec=120', '--property=TimeoutStopSec=5', '--property=Nice=19',
                 '--property=IOSchedulingClass=idle', '/usr/local/bin/nelcota', '-C', str(GUEST_ROOT),
                 '-p', PROJECT, 'pitr', 'recover', '--yes']
    result = guest.ssh(arguments, timeout=145, check=False)
    safe_private(guest, 'explicit-recover.private.log', result)
    control['explicit_P12_recovery_exit_code'] = result.returncode
    control['explicit_P12_recovery_stdout_bytes'] = len(result.stdout)
    control['explicit_P12_recovery_stderr_bytes'] = len(result.stderr)
    categories = [b'Permission denied', b'control verification failed', b'not cleanly shut down', b'heap/TOAST/B-tree',
                  b'could not finish the recovery', b'No such file', b'could not run', b'systemctl', b'amcheck', b'PITR fence']
    control['explicit_P12_recovery_diagnostic_categories'] = {key.decode(): key in result.stdout + result.stderr for key in categories}
    require(result.returncode == 0, 'Explicit verified P12 recovery failed; private diagnostic preserved')
    guest.ssh(['sudo', '-n', 'test', '!', '-e', '/var/lib/nelcota-pitr/active.json'], timeout=10)
    guest.ssh(['sudo', '-n', 'test', '!', '-e', '/var/lib/nelcota-pitr/recovery.json'], timeout=10)
    control['durable_fence_cleared_only_after_explicit_verification'] = True
    control['recovery_verification_may_install_amcheck'] = True
    ORIGINAL_RECOVER(guest, helper_command, control)


native_pitr_reboot.observe = observe
native_pitr_reboot.recover = recover
native_vm.main()
