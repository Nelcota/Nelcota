#!/usr/bin/env python3
"""Verify project isolation and local confirmation with owned Docker fixtures."""
import argparse
import base64
import hashlib
import json
import pathlib
import socket
import os
import secrets
import shlex
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def request(url, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def wait_for(task):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            value = task()
            if value:
                return value
        except (OSError, ValueError, KeyError):
            pass
        time.sleep(0.2)
    raise AssertionError('development fixture did not become ready')


def run(binary, testing_helpers=False, remote_migrations=False, browser=False):
    with tempfile.TemporaryDirectory(prefix='nelcota-dev-test-') as folder:
        root = pathlib.Path(folder).resolve()
        first, second = root / 'first', root / 'second'
        first.mkdir()
        second.mkdir()
        if remote_migrations:
            (first / 'migrations').mkdir()
            (first / 'migrations/V1__startup.sql').write_text('CREATE TABLE public.startup_fixture(id integer);')
        db_port, api_port = free_port(), free_port()
        suffix = hashlib.sha256(str(first).encode()).hexdigest()[:24]
        pg = f'nelcota-dev-postgres-{suffix}-{db_port}'
        mail = pg.replace('-postgres-', '-mail-')
        processes = []
        with tempfile.TemporaryFile() as log:
            def start():
                process = subprocess.Popen([str(binary), 'dev', '--mail', '--db-port', str(db_port), '--listen', f'127.0.0.1:{api_port}'], cwd=first, stdout=log, stderr=log)
                processes.append(process)
                return process
            try:
                start()
                base = f'http://127.0.0.1:{api_port}'
                wait_for(lambda: request(base + '/health')[0] == 200)
                if browser:
                    panel = pathlib.Path(__file__).resolve().parents[1] / 'crates/admin/ui'
                    subprocess.run(['bun', 'scripts/dev-panel.ts', base, str(first / '.nelcota/dev.env')], cwd=panel, check=True)
                if remote_migrations:
                    token = subprocess.check_output([str(binary), 'token', 'deploy', '--days', '1'], cwd=first, text=True).strip()
                    deploy_env = {**os.environ, 'NELCOTA_DEPLOY_TOKEN': token}
                    subprocess.run([str(binary), 'link', '--remote', base], cwd=second, env=deploy_env, check=True, capture_output=True)
                    (second / 'migrations').mkdir()
                    (second / 'migrations/V1__startup.sql').write_text((first / 'migrations/V1__startup.sql').read_text())
                    version_two = 'CREATE TABLE public.remote_cli_fixture(id integer);'
                    (second / 'migrations/V2__remote_cli.sql').write_text(version_two)
                    def cli(*args):
                        return subprocess.check_output([str(binary), *args], cwd=second, text=True)
                    preview = cli('migrate', '--dry-run')
                    assert 'pending' in preview
                    assert 'remote_cli_fixture:' not in cli('types')
                    cli('migrate')
                    assert 'remote_cli_fixture:' in cli('types')
                    assert 'applied' in cli('migrate', 'status')
                    altered = second / 'migrations/V1__startup.sql'
                    original = altered.read_text()
                    altered.write_text(original + '\n-- changed checksum')
                    assert 'diverged' in cli('migrate', 'status')
                    conflict = subprocess.run([str(binary), 'migrate'], cwd=second, capture_output=True)
                    assert conflict.returncode != 0
                    altered.write_text(original)
                    (first / 'migrations/V2__remote_cli.sql').write_text(version_two)
                    (first / 'migrations/V3__watched.sql').write_text('CREATE TABLE public.watched_fixture(id integer);')
                    wait_for(lambda: 'watched_fixture:' in subprocess.check_output([str(binary), 'types'], cwd=first, text=True))
                    print('PASS: startup/watch migrations, deploy-token issuance, project link, remote status/dry-run/apply/types and checksum divergence')
                if testing_helpers:
                    values = dict(line.split('=', 1) for line in (first / '.nelcota/dev.env').read_text().splitlines() if line and not line.startswith('#'))
                    database_url = shlex.split(values['DATABASE_URL'])[0]
                    sdk = pathlib.Path(__file__).resolve().parents[1] / 'sdk/typescript'
                    subprocess.run(['bun', 'run', 'build'], cwd=sdk, check=True)
                    subprocess.run(['bun', 'test/runtime/testing.mjs'], cwd=sdk, env={**os.environ, 'NELCOTA_TESTING_DATABASE_URL': database_url}, check=True)
                conflict = subprocess.run([str(binary), 'dev', '--db-port', str(db_port)], cwd=second, capture_output=True, text=True, timeout=20)
                assert conflict.returncode != 0
                assert str(first) in conflict.stderr and '--db-port' in conflict.stderr
                account = {'email': 'dev-test@localhost.test', 'password': 'local-confirmation-test-123'}
                # The verifier proves the confirming client signed up, so the
                # signup password survives confirmation.
                verifier = secrets.token_urlsafe(48)
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
                status, signup = request(base + '/auth/v1/signup', {**account, 'code_challenge': challenge, 'code_challenge_method': 'S256'})
                assert status == 201 and 'access_token' not in signup, (status, signup)
                status, rejected = request(base + '/auth/v1/token?grant_type=password', account)
                assert status == 400 and rejected['code'] == 'email_not_confirmed'
                info = json.loads(subprocess.check_output(['docker', 'inspect', mail]))[0]
                inbox = 'http://127.0.0.1:' + info['NetworkSettings']['Ports']['8025/tcp'][0]['HostPort']
                messages = wait_for(lambda: request(inbox + '/api/v1/messages')[1].get('messages'))
                message = request(inbox + '/api/v1/message/' + messages[0]['ID'])[1]
                text = message['Text']
                link = next(word for word in text.split() if '#type=signup&token=' in word)
                fragment = urllib.parse.parse_qs(urllib.parse.urlsplit(link).fragment)
                status, verified = request(base + '/auth/v1/verify', {**{key: value[0] for key, value in fragment.items()}, 'code_verifier': verifier})
                assert status == 200 and verified['access_token']
                assert request(base + '/auth/v1/token?grant_type=password', account)[0] == 200
                processes[-1].terminate()
                processes[-1].wait(timeout=15)
                start()
                wait_for(lambda: request(base + '/health')[0] == 200)
                assert request(base + '/auth/v1/token?grant_type=password', account)[0] == 200
                if remote_migrations:
                    processes[-1].terminate()
                    processes[-1].wait(timeout=15)
                    (first / 'seed.sql').write_text('INSERT INTO public.startup_fixture VALUES (42)')
                    refused = subprocess.run([str(binary), 'db', 'reset'], cwd=first, capture_output=True)
                    assert refused.returncode != 0
                    subprocess.run([str(binary), 'db', 'reset', '--yes'], cwd=first, check=True)
                    seed = subprocess.check_output(['docker', 'exec', pg, 'psql', '-U', 'postgres', '-Atc', 'SELECT id FROM public.startup_fixture'], text=True).strip()
                    assert seed == '42'
                    print('PASS: local reset requires confirmation, replays migrations and loads seed.sql')
                print('PASS: isolated projects, occupied-port refusal, STARTTLS delivery, signup confirmation and restart persistence')
            except BaseException:
                log.seek(0)
                # Server startup diagnostics contain no captured mail credentials.
                print(log.read().decode(errors='replace'))
                raise
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=15)
                for container in [mail, pg]:
                    subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(['docker', 'volume', 'rm', pg + '-data'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=pathlib.Path, required=True)
    parser.add_argument('--testing-helpers', action='store_true')
    parser.add_argument('--remote-migrations', action='store_true')
    parser.add_argument('--browser', action='store_true')
    args = parser.parse_args()
    run(args.binary.resolve(), args.testing_helpers, args.remote_migrations, args.browser)
