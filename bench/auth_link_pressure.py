"""Exercise real single-use verification; SMTP issuance remains a separate gate."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import secrets
import threading
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def rejected(status, body):
    require(type(status) is int and status == 400 and isinstance(body, dict)
            and body.get('code') == 'invalid_grant', 'Single-use link rejection differed from its contract')


def winner(results, identity):
    require(isinstance(results, list) and len(results) == 4, 'Incomplete single-use race')
    accepted = []
    for status, body in results:
        require(type(status) is int, 'Invalid single-use response status')
        if status != 200:
            rejected(status, body)
            continue
        require(isinstance(body, dict) and isinstance(body.get('user'), dict)
                and body['user'].get('id') == identity
                and isinstance(body.get('access_token'), str) and 0 < len(body['access_token']) <= 8192
                and isinstance(body.get('refresh_token'), str) and 0 < len(body['refresh_token']) <= 2048,
                'Single-use verification accepted an incomplete or foreign session')
        accepted.append(body)
    require(len(accepted) == 1, 'Single-use link did not have exactly one accepted consumer')
    return accepted[0]


def run(probes):
    """Seed generated private fixture tokens, race HTTP consumers, then revoke."""
    project = probes.project
    original_user = str(uuid.UUID(project.fixture['user']))
    cycles = []
    for cycle in range(1, 6):
        for kind in ['recovery', 'signup', 'magiclink']:
            probes.guard()
            identity = str(uuid.uuid4())
            email = 'g05-link-' + uuid.UUID(identity).hex + '@example.test'
            passwords = [secrets.token_urlsafe(32) for _ in range(4)]
            # This is private setup in the disposable run-owned database only.
            # Reuse its generated PHC, not an actual account or static password.
            confirmed = 'NULL'
            if kind == 'recovery':
                confirmed = 'now()'
            project.sql("INSERT INTO auth.users(id,email,encrypted_password,email_confirmed_at) SELECT '" + identity
                        + "','" + email + "',encrypted_password," + confirmed + " FROM auth.users WHERE id='" + original_user + "'")
            status, old = probes.json('POST', '/auth/v1/token?grant_type=password',
                                      {'email': email, 'password': project.password})
            require(status == 200 and old.get('user', {}).get('id') == identity,
                    'Generated link fixture could not establish its prior session')
            token, expired = secrets.token_hex(32), secrets.token_hex(32)
            for value, interval in [(token, "interval '5 minutes'"), (expired, "interval '-1 minute'")]:
                digest = hashlib.sha256(value.encode()).hexdigest()
                project.sql("INSERT INTO auth.one_time_tokens(user_id,kind,token_hash,expires_at) VALUES ('"
                            + identity + "','" + kind + "',decode('" + digest + "','hex'),now()+" + interval + ')')
            path = '/auth/v1/verify'
            body = {'type': kind, 'token': token, 'password': passwords[0]}
            status, value = probes.json('POST', path, {**body, 'token': expired})
            rejected(status, value)
            wrong = 'recovery'
            if kind == 'recovery':
                wrong = 'signup'
            status, value = probes.json('POST', path, {**body, 'type': wrong})
            rejected(status, value)
            with ThreadPoolExecutor(max_workers=4) as pool:
                # All four wait at the same barrier before sending their one
                # request. There are no retries or shared connection owners.
                barrier = threading.Barrier(4, timeout=5)
                def consume(index):
                    barrier.wait()
                    return probes.json('POST', path, {**body, 'password': passwords[index]})
                results = list(pool.map(consume, range(4)))
                session = winner(results, identity)
                accepted_index = next(index for index, (status, _) in enumerate(results) if status == 200)
            status, user = probes.json('GET', '/auth/v1/user', headers={'Authorization': 'Bearer ' + session['access_token']})
            require(status == 200 and user.get('id') == identity
                    and isinstance(user.get('email_confirmed_at'), str) and bool(user['email_confirmed_at']),
                    'Accepted link session did not confirm and read its own user')
            used = project.sql("SELECT count(*) FROM auth.one_time_tokens WHERE user_id='" + identity + "' AND used_at IS NOT NULL")
            expected_used = '1'
            if kind == 'magiclink':
                # First inbox proof deletes every old token and credential.
                expected_used = '0'
                remaining = project.sql("SELECT count(*) FROM auth.one_time_tokens WHERE user_id='" + identity + "'")
                require(remaining == '0', 'Inbox proof retained an earlier single-use token')
            require(used == expected_used, 'Single-use database state does not match the accepted response')
            status, value = probes.json('POST', path, body)
            rejected(status, value)
            old_status, replacement = probes.json('POST', '/auth/v1/token?grant_type=refresh_token',
                                                 {'refresh_token': old['refresh_token']})
            if kind != 'signup':
                rejected(old_status, replacement)
            if kind == 'signup':
                require(old_status == 200 and replacement.get('user', {}).get('id') == identity,
                        'Signup confirmation changed the existing refresh contract')
                status, payload = probes.read('POST', '/auth/v1/logout', headers={'Authorization': 'Bearer ' + replacement['access_token']})
                require(status == 204 and not payload, 'Prior signup session did not revoke')
            status, payload = probes.read('POST', '/auth/v1/logout', headers={'Authorization': 'Bearer ' + session['access_token']})
            require(status == 204 and not payload, 'Accepted link session did not revoke')
            if kind == 'recovery':
                status, value = probes.json('POST', '/auth/v1/token?grant_type=password', {'email': email, 'password': project.password})
                rejected(status, value)
                for index, candidate in enumerate(passwords):
                    if index == accepted_index:
                        continue
                    status, value = probes.json('POST', '/auth/v1/token?grant_type=password', {'email': email, 'password': candidate})
                    rejected(status, value)
                status, value = probes.json('POST', '/auth/v1/token?grant_type=password', {'email': email, 'password': passwords[accepted_index]})
                require(status == 200 and value.get('user', {}).get('id') == identity,
                        'Winning recovery password was not committed')
                status, payload = probes.read('POST', '/auth/v1/logout', headers={'Authorization': 'Bearer ' + value['access_token']})
                require(status == 204 and not payload, 'Recovered password session did not revoke')
            if kind == 'signup':
                status, value = probes.json('POST', '/auth/v1/token?grant_type=password', {'email': email, 'password': project.password})
                require(status == 200 and value.get('user', {}).get('id') == identity,
                        'Signup confirmation did not preserve the chosen password')
                status, payload = probes.read('POST', '/auth/v1/logout', headers={'Authorization': 'Bearer ' + value['access_token']})
                require(status == 204 and not payload, 'Confirmed password session did not revoke')
            if kind == 'magiclink':
                status, value = probes.json('POST', '/auth/v1/token?grant_type=password', {'email': email, 'password': project.password})
                rejected(status, value)
            live = project.sql("SELECT count(*) FROM auth.sessions WHERE user_id='" + identity + "' AND revoked_at IS NULL")
            require(live == '0', 'Link pressure retained an unrevoked session')
            expected_sessions = 3
            if kind == 'magiclink':
                expected_sessions = 2
            created = project.sql("SELECT count(*) FROM auth.sessions WHERE user_id='" + identity + "'")
            require(created == str(expected_sessions), 'Rejected link consumers created unexpected sessions')
            cycles.append({'cycle': cycle, 'kind': kind, 'concurrent_consumers': 4, 'accepted': 1,
                           'rejected': 3, 'expired_rejected': True, 'wrong_kind_rejected': True,
                           'replay_rejected': True, 'database_used_receipts': int(used),
                           'pending_signup_state_retired': kind == 'magiclink',
                           'created_sessions': int(created), 'unexpected_sessions': 0,
                           'prior_refresh_status': old_status, 'unrevoked_sessions_after_cleanup': 0})
    probes.retain('auth-links', {'cycles': cycles, 'scope': 'Real HTTP single-use verification during ledger traffic; '
                  'generated private tokens are seeded directly in the owned fixture database. '
                  'This does not exercise SMTP delivery, cooldown/issuance or external OAuth.'})
