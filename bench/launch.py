"""Freeze the benchmark code before starting a uniquely named long campaign."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--kind', choices=['single', 'host', 'fault', 'browser'], default='single')
    args, extra = parser.parse_known_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,79}', args.run_id):
        parser.error('Run ID must be a bounded lowercase label')
    binary = args.binary.resolve(strict=True)
    output = ROOT / 'target/stress-g05' / args.run_id
    snapshot = ROOT / 'target/stress-g05/harness-snapshots' / args.run_id
    if output.exists() or snapshot.exists():
        parser.error('This run already exists; preserve it and use a new ID')
    snapshot.mkdir(parents=True)
    sources = sorted((ROOT / 'bench').glob('*.py')) + sorted((ROOT/'bench').glob('*.c')) + [ROOT/'bench/campaign.js', ROOT/'bench/browser_auth.js', ROOT/'bench/setup.sql', ROOT/'scripts/upgrade/support.py']
    hashes = {}
    for source in sources:
        name = source.relative_to(ROOT)
        target = snapshot / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o444)
        hashes[str(name)] = hashlib.sha256(target.read_bytes()).hexdigest()
    (snapshot / 'launch.json').write_text(json.dumps({'run_id': args.run_id, 'git': subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(), 'binary_sha256': hashlib.file_digest(binary.open('rb'),'sha256').hexdigest(), 'harness_sources': hashes}, indent=2)+'\n')
    entrypoint = 'campaign.py'
    if args.kind == 'host':
        entrypoint = 'host_campaign.py'
    if args.kind == 'fault':
        entrypoint = 'fault_campaign.py'
    if args.kind == 'browser':
        entrypoint = 'browser_campaign.py'
    child=None
    pending_signal=None
    previous=signal.getsignal(signal.SIGTERM)
    def terminate(signum,frame):
        nonlocal pending_signal
        pending_signal=signum
        if child is not None and child.poll() is None:
            child.send_signal(signum)
    signal.signal(signal.SIGTERM,terminate)
    try:
        child=subprocess.Popen([sys.executable,str(snapshot/'bench'/entrypoint),'--binary',str(binary),'--output',str(output),*extra],cwd=ROOT)
        if pending_signal is not None:
            child.send_signal(pending_signal)
        result=child.wait()
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=60)
            except subprocess.TimeoutExpired:
                child.kill()  # The campaign's independent watchdog owns teardown.
                child.wait(timeout=10)
        signal.signal(signal.SIGTERM,previous)
        output.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(snapshot/'launch.json',output/'launch-manifest.json')
    raise SystemExit(result)


if __name__ == '__main__':
    main()
