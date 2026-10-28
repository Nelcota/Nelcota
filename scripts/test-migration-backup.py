#!/usr/bin/env python3
"""Verify automatic pre-migration backups with an owned PostgreSQL/file fixture."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def wait_for(check, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError, subprocess.CalledProcessError):
            pass
        time.sleep(0.1)
    raise AssertionError('backup acceptance fixture did not become ready')


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def run(binary):
    clean_env = {key: value for key, value in os.environ.items() if not key.startswith('NELCOTA_')}
    with tempfile.TemporaryDirectory(prefix='nelcota-migration-backup-') as folder:
        root = Path(folder)
        host, project = root / 'host', root / 'host/projects/shop'
        project.mkdir(parents=True)
        project.chmod(0o700)
        (project / 'storage/files').mkdir(parents=True)
        (project / 'migrations').mkdir()
        (host / 'host.env').write_text('')
        (host / 'host.env').chmod(0o600)
        (host / 'nelcota-host.json').write_text(json.dumps({
            'version': 1, 'panel_login': 'per-project', 'local': True,
            'runtime': 'docker', 'image': 'unused-fixture',
            'projects': [{'name': 'shop', 'domain': 'shop.localhost'}],
        }))
        compose = ['docker', 'compose', '--project-directory', str(project)]
        (project / 'docker-compose.yml').write_text(f'''name: nelcota-backup-{secrets.token_hex(8)}
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: fixture
    ports: ["127.0.0.1::5432"]
    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]
    tmpfs: ["/var/lib/postgresql/data"]
''')
        processes = []
        with (root / 'acceptance.log').open('w+') as log:
            def command(*args, env=None, input=None):
                return subprocess.check_output(list(args), env=env or clean_env, input=input, text=True, stderr=log)

            def pg(sql, database='postgres'):
                return command(*compose, 'exec', '-T', '-u', 'postgres', 'postgres', 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', sql).strip()

            def start_agent():
                process = subprocess.Popen([str(binary), '-C', str(host), '-p', 'shop', 'migration-backup', 'serve', '--socket', str(agent_socket)], env=clean_env, stdout=log, stderr=log)
                processes.append(process)
                wait_for(lambda: agent_socket.exists() and not fence.exists())
                return process

            def api(path, value=None):
                data = None if value is None else json.dumps(value).encode()
                request = urllib.request.Request(base + path, data=data, headers={
                    'Content-Type': 'application/json', 'Authorization': 'Bearer ' + deploy_token,
                })
                try:
                    with urllib.request.urlopen(request, timeout=45) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)

            files = []

            def migration(version, sql, dry_run=False):
                return api('/admin/deploy/v1/migrations', {'files': files + [{'filename': f'V{version}__fixture.sql', 'sql': sql}], 'dry_run': dry_run})

            try:
                subprocess.run(compose + ['up', '-d', 'postgres'], env=clean_env, stdout=log, stderr=log, check=True)
                wait_for(lambda: command(*compose, 'exec', '-T', 'postgres', 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'))
                db_port = command(*compose, 'port', 'postgres', '5432').strip().rsplit(':', 1)[1]
                api_port = free_port()
                base = f'http://127.0.0.1:{api_port}'
                agent_socket = root / 'ipc/agent.sock'
                fence = host / '.migration-backup-active'
                config = {
                    'NELCOTA_DATABASE_URL': f'postgres://postgres:fixture@127.0.0.1:{db_port}/postgres',
                    'NELCOTA_AUTHENTICATOR_PASSWORD': secrets.token_hex(20),
                    'NELCOTA_JWT_SECRET': secrets.token_hex(32), 'NELCOTA_JWT_ISSUER': base,
                    'NELCOTA_LISTEN': f'127.0.0.1:{api_port}', 'NELCOTA_STORAGE_BACKEND': 'disk',
                    'NELCOTA_STORAGE_DIR': str(project / 'storage'), 'NELCOTA_PRODUCTION': 'true',
                    # Panel password login is deliberately unusable; deploy credentials
                    # are issued locally by the fixture owner, never by this placeholder.
                    'NELCOTA_ADMIN_EMAIL': 'fixture@example.test',
                    'NELCOTA_ADMIN_PASSWORD_HASH': 'unusable-fixture-password-hash',
                    'NELCOTA_MIGRATION_BACKUP_TOKEN': secrets.token_hex(32),
                    'NELCOTA_MIGRATION_BACKUP_SOCKET': str(agent_socket),
                }
                (project / '.env').write_text(''.join(f'{key}={value}\n' for key, value in config.items()))
                (project / '.env').chmod(0o600)
                app_env = {**clean_env, **config}
                server = subprocess.Popen([str(binary), 'serve'], cwd=root, env=app_env, stdout=log, stderr=log)
                processes.append(server)
                def healthy():
                    assert server.poll() is None, 'fixture server exited before readiness'
                    with urllib.request.urlopen(base + '/health', timeout=2) as response:
                        return response.status == 200
                wait_for(healthy)
                deploy_token = command(str(binary), 'token', 'deploy', '--days', '1', env=app_env).strip()
                initial = 'CREATE TABLE public.backup_fixture(id int4, payload text); INSERT INTO public.backup_fixture VALUES (42, \'before\');'
                assert migration(1, initial, True)[0] == 200
                assert migration(1, initial)[0] == 503
                assert pg("SELECT to_regclass('public.backup_fixture') IS NULL") == 't'
                agent = start_agent()
                status, result = migration(1, initial)
                assert status == 200, result
                files.append({'filename': 'V1__fixture.sql', 'sql': initial})
                wait_for(lambda: not fence.exists())
                version = '00000000-0000-4000-8000-000000000042'
                payload = b'immutable bytes before migration\n'
                (project / 'storage/files' / version).write_bytes(payload)
                pg(f"INSERT INTO storage.buckets(id) VALUES ('files'); INSERT INTO storage.objects(bucket_id,name,version,size,mime_type,etag) VALUES ('files','example.txt','{version}',{len(payload)},'text/plain','fixture');")
                destructive = 'ALTER TABLE public.backup_fixture DROP COLUMN payload; DELETE FROM storage.objects;'
                status, result = migration(2, destructive)
                assert status == 200, result
                files.append({'filename': 'V2__fixture.sql', 'sql': destructive})
                wait_for(lambda: not fence.exists())
                dump = project / 'backups' / result['report']['backup']
                bundle = dump.with_name(dump.name + '.files')
                manifest = json.loads((bundle / 'manifest.json').read_text())
                saved = bundle / 'objects/files' / version
                assert saved.read_bytes() == payload
                assert manifest['objects'][0]['sha256'] == hashlib.sha256(payload).hexdigest()
                assert dump.stat().st_mode & 0o077 == 0
                (project / 'storage/files' / version).unlink()
                pg('CREATE DATABASE restored_backup')
                with dump.open('rb') as source:
                    subprocess.run(compose + ['exec', '-T', '-u', 'postgres', 'postgres', 'pg_restore', '--exit-on-error', '-d', 'restored_backup'], stdin=source, stdout=log, stderr=log, check=True)
                assert pg('SELECT payload FROM public.backup_fixture WHERE id=42', 'restored_backup') == 'before'
                assert pg('SELECT version FROM storage.objects', 'restored_backup') == version
                print('PASS: automatic backup precedes destructive SQL; real pg_restore recovers data/metadata and verified immutable bytes', flush=True)
                pg(f"INSERT INTO storage.objects(bucket_id,name,version,size,mime_type,etag) VALUES ('files','missing.txt','{version}',1,'text/plain','missing');")
                blocked = 'CREATE TABLE public.must_not_run(id int4)'
                assert migration(3, blocked)[0] == 503
                assert pg("SELECT to_regclass('public.must_not_run') IS NULL") == 't'
                wait_for(lambda: not fence.exists())
                pg('DELETE FROM storage.objects')
                print('PASS: missing backup bytes fail closed before SQL', flush=True)
                before = list((project / 'backups').glob('*.dump'))
                with socket.socket(socket.AF_UNIX) as unauthorized:
                    unauthorized.connect(str(agent_socket))
                    unauthorized.sendall(b'1' + b'0' * 64)
                    assert unauthorized.recv(4) == b''
                assert not fence.exists() and len(before) == len(list((project / 'backups').glob('*.dump')))
                print('PASS: an invalid project backup capability has no host effects', flush=True)
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    interrupted = executor.submit(migration, 3, 'CREATE TABLE public.canceled_migration(id int4); SELECT pg_sleep(30);')
                    wait_for(lambda: pg("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='postgres' AND wait_event='PgSleep')") == 't')
                    agent.kill()
                    agent.wait(timeout=5)
                    assert interrupted.result(timeout=5)[0] == 503
                assert pg("SELECT to_regclass('public.canceled_migration') IS NULL") == 't'
                assert fence.exists(), 'a crashed agent must leave a durable host fence'
                refused = subprocess.run([str(binary), '-C', str(host), '-p', 'shop', 'backup'], env=clean_env, stdout=log, stderr=subprocess.PIPE, text=True)
                assert refused.returncode != 0 and 'migration backup needs recovery' in refused.stderr
                agent_socket.unlink(missing_ok=True)
                agent = start_agent()
                assert not fence.exists()
                print('PASS: agent death cancels SQL, fences host mutations and recovers only after the DB lock is released', flush=True)
                completed = 'CREATE TABLE public.after_recovery(id int4)'
                assert migration(3, completed)[0] == 200
                files.append({'filename': 'V3__fixture.sql', 'sql': completed})
                wait_for(lambda: not fence.exists())
                stop(agent)
                count = len(list((project / 'backups').glob('*.dump')))
                assert api('/admin/deploy/v1/migrations', {'files': files})[0] == 200
                assert migration(4, blocked, True)[0] == 200
                assert len(list((project / 'backups').glob('*.dump'))) == count
                print('PASS: previews and idempotent replays do not require or create another backup', flush=True)
                agent_socket.unlink(missing_ok=True)
                start_agent()
                for item in files + [{'filename': 'V4__fixture.sql', 'sql': 'CREATE TABLE public.direct_cli_backup(id int4)'}]:
                    (project / 'migrations' / item['filename']).write_text(item['sql'])
                command(str(binary), 'migrate', '--local', '--path', str(project / 'migrations'), env=app_env)
                wait_for(lambda: not fence.exists())
                assert pg("SELECT to_regclass('public.direct_cli_backup') IS NOT NULL") == 't'
                assert len(list((project / 'backups').glob('*.dump'))) == count + 1
                print('PASS: direct CLI migrations use the same automatic backup gate', flush=True)
            except BaseException:
                log.flush()
                log.seek(0)
                print(log.read()[-16000:])
                raise
            finally:
                for process in reversed(processes):
                    stop(process)
                subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], env=clean_env, stdout=log, stderr=log, check=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    run(parser.parse_args().binary.resolve(strict=True))
