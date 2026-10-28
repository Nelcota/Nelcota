#!/usr/bin/env python3
"""Verify project isolation and local confirmation with owned Docker fixtures."""
import argparse
import hashlib
import json
import pathlib
import socket
import os
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


def run(binary, testing_helpers=False):
    with tempfile.TemporaryDirectory(prefix='nelcota-dev-test-') as folder:
        root = pathlib.Path(folder).resolve()
        first, second = root / 'first', root / 'second'
        first.mkdir()
        second.mkdir()
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
                status, signup = request(base + '/auth/v1/signup', account)
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
                status, verified = request(base + '/auth/v1/verify', {key: value[0] for key, value in fragment.items()})
                assert status == 200 and verified['access_token']
                assert request(base + '/auth/v1/token?grant_type=password', account)[0] == 200
                processes[-1].terminate()
                processes[-1].wait(timeout=15)
                start()
                wait_for(lambda: request(base + '/health')[0] == 200)
                assert request(base + '/auth/v1/token?grant_type=password', account)[0] == 200
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
    args = parser.parse_args()
    run(args.binary.resolve(), args.testing_helpers)
