"""Check real Docker ignore behavior using synthetic, disposable context files.

No repository source, real environment file, credentials or network is sent to
the builder. Requires the same local Docker access as native acceptance.
"""
import argparse
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tarfile
import tempfile

REPO = Path(__file__).resolve().parents[1]
KEEP = [
    'Cargo.toml', 'Cargo.lock', 'crates/core/src/lib.rs',
    'scripts/install.sh',
    'crates/admin/ui/dist/index.html', 'sdk/typescript/src/index.ts',
    'sdk/nextjs/src/index.ts', '.env.example',
    'sdk/nextjs/examples/app-router/.env.example',
    'dist/nelcota-amd64', 'dist/nelcota-arm64',
    'migrations/V1__roles_e_auth.sql',
    'crates/core/migrations/V1__roles_e_auth.sql',
]
PRIVATE = [
    '.env', 'host.env', 'projects/demo/.env',
    'sdk/nextjs/examples/app-router/.env.local',
    '.tools/reports/onboarding/run/.nelcota/dev.env',
    '.tools/reports/host-management/private.json',
    'sdk/nextjs/node_modules/package/index.js',
    'sdk/nextjs/examples/app-router/node_modules/package/index.js',
    'crates/admin/ui/node_modules/package/index.js',
    'sdk/typescript/node_modules/package/index.js',
    'target/debug/nelcota', 'sdk/rust/target/debug/consumer',
    'sdk/nextjs/examples/app-router/.next/server/app/page.js',
    'nested/.nelcota/dev.env',
]


def docker(*args, check=True):
    return subprocess.run(['docker', *args], check=check, capture_output=True, timeout=90)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dockerignore', type=Path, default=REPO / '.dockerignore')
    args = parser.parse_args()
    token = secrets.token_hex(8)
    image = 'nelcota-audit-context:' + token
    label = 'nelcota.audit.context=' + token
    container = None
    with tempfile.TemporaryDirectory(prefix='nelcota-context-') as directory:
        root = Path(directory)
        buildx = root / 'buildx'
        buildx.mkdir()
        # Keep the session's registry credentials/proxy; only Buildx state needs
        # a writable location. The synthetic build has no RUN or network step.
        os.environ['BUILDX_CONFIG'] = str(buildx)
        context = root / 'context'
        context.mkdir()
        for name in KEEP + PRIVATE:
            path = context / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic audit fixture; never a real secret\n')
        shutil.copyfile(args.dockerignore, context / '.dockerignore')
        (context / 'Dockerfile').write_text('FROM scratch\nCOPY . /context/\n')
        try:
            result = docker('build', '--network', 'none', '--label', label, '-t', image, str(context), check=False)
            if result.returncode:
                raise RuntimeError('Synthetic context build failed: ' + result.stderr.decode(errors='replace')[-3000:])
            container = docker('create', '--label', label, image, '/unused').stdout.decode().strip()
            archive = docker('export', container).stdout
            with tarfile.open(fileobj=io.BytesIO(archive), mode='r:') as stream:
                names = {member.name.removeprefix('context/') for member in stream if member.isfile()}
            missing = [name for name in KEEP if name not in names]
            leaked = [name for name in PRIVATE if name in names]
            print(json.dumps({'kept_source_cases': len(KEEP), 'private_or_generated_cases': len(PRIVATE),
                              'missing_required_source': missing, 'unexpected_context_files': leaked,
                              'network': 'none', 'data': 'synthetic only'}, indent=2), flush=True)
            if missing or leaked:
                raise SystemExit('Docker context boundary failed')
        finally:
            if container:
                docker('rm', '-v', container)
            inspection = docker('image', 'inspect', image, check=False)
            if inspection.returncode == 0:
                metadata = json.loads(inspection.stdout)[0]
                assert metadata['Config']['Labels'].get('nelcota.audit.context') == token
                docker('image', 'rm', image)


if __name__ == '__main__':
    main()
