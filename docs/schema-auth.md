# The `auth` schema

A public, stable contract. Every table is ordinary SQL: you can read, export
and migrate it without Nelcota (see [leaving.md](leaving.md)).

The tables are **not** exposed by the REST API. The server reaches them with
the internal role `nelcota_auth`, which no JWT can assume. `anon`,
`authenticated` and `service_role` have no GRANT on them (there is a test for
that).

## Prerequisites

You need a running initialized server. Password login is available by default;
SMTP/link pages and OAuth providers are optional configuration groups. Schema
and endpoint examples describe current source, with release differences tracked
in the server changelog. Never expose database password hashes or link tokens.

## `auth.users`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()`; it is the JWT `sub` and `auth.uid()` |
| `email` | `text` unique | always lowercase, ≤ 254 characters |
| `encrypted_password` | `text` | **argon2id PHC string** (see below); `NULL` = no password |
| `email_confirmed_at` | `timestamptz` | set when the person opens a signup confirmation, magic or recovery link (proves they receive the email) |
| `raw_user_meta_data` | `jsonb` | the signup `data` field; returned as `user_metadata` |
| `created_at`, `updated_at` | `timestamptz` | |
| `last_sign_in_at` | `timestamptz` | updated on every login |

### Password format

Account emails use a simple mailbox address: a dot-atom ASCII local part (up
to 64 bytes), a DNS domain with nonempty labels, and at most 254 bytes overall.
Surrounding spaces are trimmed and the address is lowercased. Controls, display
names, quoted local parts and consecutive dots are rejected before hashing or
querying the database, using the same rule for public auth and panel accounts.
International domains can use their ASCII/Punycode form. Existing malformed
addresses are not renamed automatically; an administrator should verify
ownership before repairing such a row in SQL.

The server shares one bounded Argon2 worker budget between public auth, panel
login and account administration. Panel login rate limits apply per client IP;
forwarded headers are used only when `trust_proxy` is configured.

```
$argon2id$v=19$m=19456,t=2,p=1$<salt base64>$<hash base64>
```

It is the standard PHC format. The parameters (19 MiB, 2 iterations,
parallelism 1) follow the OWASP recommendation. It works directly with any
argon2 library: Python `argon2-cffi` (`PasswordHasher().verify(hash,
password)`), Node `argon2` (`argon2.verify(hash, password)`), Go
`alexedwards/argon2id`, PHP `password_verify()`, Keycloak/Authentik via import.

## `auth.sessions`

One row per login.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | goes into the JWT as the `session_id` claim |
| `user_id` | `uuid` → `auth.users` | `ON DELETE CASCADE` |
| `created_at`, `refreshed_at` | `timestamptz` | |
| `revoked_at` | `timestamptz` | logout or detected refresh token reuse |
| `user_agent`, `ip` | `text`, `inet` | informative |

## `auth.refresh_tokens`

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` PK | |
| `session_id` | `uuid` → `auth.sessions` | the token's "family" |
| `token_hash` | `bytea` unique | **SHA-256** of the opaque token; the token itself is never stored |
| `revoked` | `boolean` | `true` once used (rotation) |
| `created_at`, `expires_at` | `timestamptz` | default validity: 30 days |

### Rotation and reuse detection

1. `POST /auth/v1/token?grant_type=refresh_token` with token R1.
2. R1 valid → marked `revoked = true`; R2 is issued in the same session.
3. If R1 is used **again** (someone has a copy), the whole session is revoked:
   R2, R3... stop working. The user's other sessions continue.

**Retry grace window.** A client that lost the answer to step 2 (network drop,
two tabs refreshing at once) still holds only R1. For **10 seconds** after the
rotation, presenting R1 again is treated as a retry: the server revokes R2 (and
any other live token of the session issued after R1) and answers with a fresh
pair for the **same session**. Retries never extend the window, which counts
from the original rotation (its `refreshed_at`). Once R2's successor has been
rotated in turn, or after the window, R1 is reuse again and step 3 applies.
The client should still serialize refreshes; the window only absorbs retries.

Retry grace also requires R1 to remain unexpired: `expires_at <= now()` is
expired, including at the exact deadline. An expired, rotated token follows
reuse handling and ends that session; it never issues another pair.

### Cleanup

Once an hour the server deletes refresh tokens past `expires_at` (a rotated
token stays until then, so reuse is still detected), sessions left without
any token, and sessions revoked more than 7 days ago (with their tokens).
Nothing that could still sign anyone in is removed.

## `auth.one_time_tokens`

Links sent by email: password recovery, signup confirmation and magic link.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigint` PK | |
| `user_id` | `uuid` → `auth.users` | `ON DELETE CASCADE` |
| `kind` | `text` | `recovery`, `signup` or `magiclink`; a token only works as its kind |
| `token_hash` | `bytea` unique | **SHA-256** of the token; the token itself is never stored |
| `created_at`, `expires_at` | `timestamptz` | validity: recovery 1 hour, signup 24 hours, magic link 15 minutes |
| `used_at` | `timestamptz` | set on use; the link does not work again |

## `auth.identities`

Accounts at sign-in providers linked to a user (see
[Sign-in with Google or GitHub](#sign-in-with-google-or-github)).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `user_id` | `uuid` → `auth.users` | `ON DELETE CASCADE` |
| `provider` | `text` | `google` or `github` |
| `provider_id` | `text` | the provider's account id (`sub`); unique per provider |
| `email` | `text` | the email the provider reported at the last sign-in |
| `identity_data` | `jsonb` | the provider's profile as received |
| `created_at`, `updated_at`, `last_sign_in_at` | `timestamptz` | |

## `auth.flow_states`

Provider sign-ins in progress; each row lives minutes.

| Column | Type | Notes |
|---|---|---|
| `state_hash` | `bytea` unique | **SHA-256** of the `state` sent to the provider |
| `provider` | `text` | |
| `provider_verifier` | `text` | PKCE verifier toward the provider; atomically cleared when claiming the callback, before HTTP exchange |
| `code_challenge` | `text` | the app's S256 challenge |
| `redirect_to` | `text` | the app page to return to |
| `auth_code_hash` | `bytea` unique | **SHA-256** of the code handed to the app |
| `user_id` | `uuid` → `auth.users` | set when the provider answers |
| `created_at`, `expires_at` | `timestamptz` | 10 minutes at the provider, then 5 to redeem the code |

Only one callback can claim a state, even while the provider is still
responding. Failed or cancelled exchanges require a new `/authorize`; no
database transaction remains open during provider HTTP requests. Callback
requests have a separate per-IP budget from `/authorize`.

In-memory limiters track at most 50,000 keys. At capacity they reject new
keys with `429` and a one-second retry hint, while existing keys keep their
independent quotas. Cleanup runs at most once per second under capacity
pressure and removes only keys idle since their last accepted request for
a full minute, enough to recover the complete GCRA burst.

## Endpoints

| Method and route | Body | Response |
|---|---|---|
| `POST /auth/v1/signup` | `{email, password, data?}` | 201 + session (201 `{user}` with email confirmation on) |
| `POST /auth/v1/token?grant_type=password` | `{email, password}` | 200 + session |
| `POST /auth/v1/token?grant_type=refresh_token` | `{refresh_token}` | 200 + session |
| `POST /auth/v1/token?grant_type=pkce` | `{auth_code, code_verifier}` | 200 + session |
| `GET /auth/v1/authorize` | `?provider&redirect_to&code_challenge&code_challenge_method=S256` | 303 to the provider |
| `GET /auth/v1/callback` | (the provider's redirect) | 303 to `redirect_to?code=...` or `?error=...` |
| `POST /auth/v1/logout` | Bearer | 204 (revokes the session) |
| `GET /auth/v1/user` | Bearer | user data |
| `PUT /auth/v1/user` | Bearer + `{password?, current_password?, data?}` | 200 + user data (see [Updating the signed-in user](#updating-the-signed-in-user)) |
| `GET /auth/v1/.well-known/jwks.json` | - | public JWKS |
| `POST /auth/v1/recover` | `{email}` | 200 `{}` (whether or not the account exists) |
| `POST /auth/v1/magiclink` | `{email}` | 200 `{}` (whether or not the account exists) |
| `POST /auth/v1/resend` | `{type: "signup", email}` | 200 `{}` (whether or not the account exists) |
| `POST /auth/v1/verify` | `{type: "recovery", token, password}` or `{type: "signup" \| "magiclink", token}` | 200 + session |

Auth handlers send `Cache-Control: no-store` and `Pragma: no-cache` on session,
account, email-link and OAuth responses, including handler errors and redirects.
The public JWKS keeps `Cache-Control: public, max-age=300`; it contains no secrets.
Response bodies, statuses and SDK payloads are unchanged.

Session:

```json
{
  "access_token": "<JWT>",
  "token_type": "bearer",
  "expires_in": 900,
  "expires_at": 1767225600,
  "refresh_token": "<opaque>",
  "user": { "id": "...", "email": "...", "user_metadata": {}, "created_at": "...", "last_sign_in_at": "...", "email_confirmed_at": null }
}
```

Errors: `422 invalid_email` or `422 weak_password` (email or password outside
the rules), `422 validation_failed` (a value the endpoint requires is missing,
such as `refresh_token`), `400`/`422 invalid_body` (the body is not JSON or a
field has the wrong type), `409
user_already_exists`, `400 invalid_grant` (invalid credentials or refresh, with
the same message for an unknown email and a wrong password), `429
rate_limited` with `Retry-After`, `403 signup_disabled`, `400
email_not_confirmed` (correct password, email confirmation pending).

Links: `403 recovery_disabled`, `confirmation_disabled` or `magiclink_disabled`
(the project has not configured that flow), `400 invalid_grant` (invalid,
expired, already used or other-kind link), `400 unsupported_type`.

Email flows share **16 delivery slots** per process and a **30-second** total
send deadline, including custom mailers. Overload returns `503 mail_busy`
before creating an account or issuing a token, with the same response for
existing and unknown accounts. An admitted background send owns its slot until
it completes or times out.
SMTP errors and timeouts are logged; sending remains a best-effort background
operation rather than a durable delivery queue.

Password: 8 to 256 characters. Password login has hard limits of
`NELCOTA_AUTH_RATE_LIMIT_PER_MINUTE` per IP (default 30) and per normalized
email/IP pair. All attempts count, including successful and unknown-account
attempts. Each bucket allows a burst of that size and refills continuously
at that many attempts per minute; the shared per-IP budget remains unchanged.

The account aggregate uses the same quota for backpressure, rather than hard
rejection: excess attempts wait 125, 250, 500, 1,000, then at most 2,000 ms.
A refill admission resets the delay progression. Waiting holds neither a DB
connection nor a password worker. A correct login from an independent source
with available IP/pair budgets inherits at most two seconds of throttle delay,
even during continuing account-targeted abuse. Normal request deadlines,
worker admission/overload responses and bounded limiter capacity still apply.

Trade-off: a strict account-wide verification ceiling cannot also guarantee
admission of an unrecognized legitimate source when attackers continuously
spend that ceiling. Distributed sources can now exceed the former aggregate
ceiling; each source and email/source pair retain the original hard quota.
The aggregate delay is backpressure, not a distributed brute-force ceiling.
Keep trusted proxy configuration and upstream abuse controls; limits are per
process and shared NAT users still share their IP budget.

Refreshes and PKCE redemptions (`grant_type=refresh_token` / `pkce`) draw from
a separate per-IP budget of 10 times that (300 by default), so open tabs
refreshing do not use up the password sign-in budget.

## Updating the signed-in user

`PUT /auth/v1/user` with the user's access token changes their own account.
Send at least one of:

- `data`: merged into `user_metadata` (`raw_user_meta_data`) one level deep:
  the keys sent replace the stored ones, the others stay, and a key sent as
  `null` is removed. `{"data": {"plan": "pro", "tmp": null}}`.
- `password` (same rules as signup): requires `current_password` when the
  account already has a password (`422 validation_failed` without it, `400
  invalid_grant` when wrong). An account without one (magic link or provider
  sign-in) can set it directly. The user's **other** sessions are revoked;
  the calling session and its refresh token keep working. Attempts count
  against the per-minute limit, per user.

The access token's session must still be active (not logged out or revoked):
otherwise `401 invalid_token`. The response is the updated user, as in `GET
/auth/v1/user`. Changing the email is not supported yet (it needs a
confirmation of the new address); an administrator can change it in SQL.

Password replacement through the signed-in account, recovery completion or
panel administration retires that user's pending email credentials and OAuth
codes in the same transaction. Existing token issuance history remains for
email send cooldowns; unrelated accounts are unchanged. Account-row locking
serializes replacement with credential redemption. A database error rolls
back the password, session and pending-credential changes together.

## Password recovery

Off until the project configures SMTP (Nelcota has no mail server of its own;
use your provider's: Postmark, SES, Resend...). In the project's `.env`, all
three together:

```sh
NELCOTA_SMTP_URL=smtps://user:password@smtp.example.com:465   # or smtp://...:587?tls=required
NELCOTA_SMTP_FROM='Shop <no-reply@shop.com>'
NELCOTA_PASSWORD_RECOVERY_URL=https://app.shop.com/new-password
```

A half-configured setup stops the server from starting (better than finding
out on the first "forgot my password").

The SMTP mailer accepts implicit TLS (`smtps://`) or mandatory STARTTLS
(`smtp://` with `tls=required`). The only query option is one `tls=required`;
it is optional for SMTPS. Plain SMTP, opportunistic TLS, fragments, repeated
TLS settings and unknown query options are refused before delivery, including
on loopback. Fix an existing URL before restarting the updated server; never
disable certificate verification. Custom mail adapters must enforce their
own transport security.

When SMTP is disabled, there is no self-service email reset. An operator must
verify the account owner's identity through a separate trusted channel, sign
in to the project panel, open **Users**, select the account and reset its
password. Deliver the replacement privately. This ends refresh sessions but
does not erase IP/pair throttle state or revoke existing access JWTs before
expiry. Stop abusive sources at the trusted ingress, then retry from an
independent source or allow at most 60 seconds without new attempts for full
bucket refill. There is no persistent account lock to unlock. Do not restart
the service or disable limits as a recovery shortcut.

1. The app calls `POST /auth/v1/recover {email}`. The answer is always
   `200 {}`, so it does not reveal who has an account. If the account exists,
   an email arrives (in English, subject "Reset your password") with the link
   `https://app.shop.com/new-password#type=recovery&token=...`.
2. That app page reads the token from the fragment (`location.hash`), asks for
   the new password and calls `POST /auth/v1/verify {type: "recovery", token,
   password}`.
3. The response is a session (same format as login): the person is signed in.

Guarantees:

- The token travels in the URL fragment, which the browser sends to no server:
  it does not show up in logs or in the `Referer`.
- It is valid for 1 hour and only once. Asking again voids the previous link.
- At most one email per minute for the same account, on top of the per-IP
  rate limit: the endpoint cannot be used to flood someone's inbox.
- The email goes out in the background: response time does not reveal whether
  the account exists, and an SMTP failure goes to the log instead of becoming
  an error.
- Changing the password ends every session of the account (refresh tokens stop
  working immediately; access JWTs already issued stay valid until they
  expire).

## Signup confirmation

Off by default. With SMTP configured, setting the page that receives the link
turns it on:

```sh
NELCOTA_EMAIL_CONFIRMATION_URL=https://app.shop.com/welcome
```

1. `POST /auth/v1/signup` creates the account and answers `201 {"user": {...}}`
   **without** a session; an email ("Confirm your email") carries
   `https://app.shop.com/welcome#type=signup&token=...`, valid for 24 hours.
2. The page reads the token from the fragment and calls `POST /auth/v1/verify
   {type: "signup", token}`: the email is confirmed and the answer is a session.
3. Until then, password sign-in answers `400 email_not_confirmed`, only after a
   correct password. `POST /auth/v1/resend {type: "signup", email}` sends a new
   link to an unconfirmed account (same cooldown and `200 {}` as recovery).

Opening a magic or recovery link also confirms the email. Accounts that were
already unconfirmed when the flow was turned on are held as well; mark them
with "Confirm email" on the panel's Users page (or `UPDATE auth.users SET
email_confirmed_at = now()`) if they should keep signing in. Accounts created
in the panel are confirmed from the start.

When recovery first confirms an account, it removes provider identities and
pending OAuth/email codes established before that inbox proof, revokes previous
sessions and installs the owner's new password in the same transaction.
Recovery of an already confirmed account preserves its linked providers while
still changing the password and revoking the existing sessions.

## Magic link

Passwordless sign-in for existing accounts, on when its page is configured:

```sh
NELCOTA_MAGIC_LINK_URL=https://app.shop.com/signed-in
```

1. `POST /auth/v1/magiclink {email}` always answers `200 {}`. If the account
   exists, an email ("Your sign-in link") carries
   `https://app.shop.com/signed-in#type=magiclink&token=...`, valid for 15
   minutes.
2. The page calls `POST /auth/v1/verify {type: "magiclink", token}` and gets a
   session; the email counts as confirmed.

On the first proof of inbox ownership, a magic link clears any password from
the unconfirmed signup and revokes its earlier sessions, provider identities,
pending OAuth codes and email links. Someone else may have registered that
address. The inbox owner can set
a new password through recovery. Already confirmed accounts keep their
password and sessions; signup confirmation still approves its signup password.
Revoked sessions cannot refresh, while previously issued access JWTs retain
their normal expiry (as for logout and password recovery).

It does not create accounts: an email request would otherwise let anyone
reserve addresses before their owners sign up. Same guarantees as recovery:
token only in the fragment, one use, one email per minute per account,
sending in the background.

## Sign-in with Google or GitHub

Off until a provider is configured. Register an OAuth app at the provider with
the callback `https://<api domain>/auth/v1/callback`, then:

```sh
NELCOTA_API_URL=https://api.shop.com
NELCOTA_OAUTH_REDIRECT_URLS=https://shop.com/auth,http://localhost:5173/auth
NELCOTA_OAUTH_GOOGLE_CLIENT_ID=...
NELCOTA_OAUTH_GOOGLE_CLIENT_SECRET=...
NELCOTA_OAUTH_GITHUB_CLIENT_ID=...
NELCOTA_OAUTH_GITHUB_CLIENT_SECRET=...
```

A half-configured provider, or a provider without the two URLs, stops the
server from starting.

1. The app creates a PKCE pair: a random `code_verifier` (43 to 128
   characters) kept in the browser and `code_challenge =
   base64url(SHA-256(code_verifier))`. It sends the person to
   `GET /auth/v1/authorize?provider=github&redirect_to=https://shop.com/auth&code_challenge=...&code_challenge_method=S256`.
2. After the provider, the person lands on
   `https://shop.com/auth?code=...` (or `?error=...`).
3. The page calls `POST /auth/v1/token?grant_type=pkce {auth_code,
   code_verifier}` and gets a session (same format as login).

Errors on `redirect_to`: `access_denied` (the person declined),
`provider_error`, `email_conflict` (the provider did not verify an email that
belongs to an account), `email_required` (the provider gave no email),
`signup_disabled`. `/authorize` answers `400 redirect_not_allowed`, `400
invalid_code_challenge` or `403 provider_disabled`; `/callback` answers `400
invalid_state` for an unknown, expired or already answered sign-in.

Which account opens:

- a provider account already linked: its user, even if the email changed at
  the provider;
- an email the provider **verified** that matches a confirmed account: that
  account, which gains the identity (its password keeps working);
- a verified email that matches an **unconfirmed** account: the verified owner
  takes it over; the previous password, sessions, provider identities and
  pending email/OAuth codes are removed, then the verified identity is linked,
  since whoever created it may not own the address;
- an unverified email that matches an account: refused (`email_conflict`);
- no account: a new one without password, confirmed when the provider verified
  the email, with `user_metadata` `name` and `avatar_url` from the provider.

Guarantees: `redirect_to` must sit under one of `NELCOTA_OAUTH_REDIRECT_URLS`
(same origin, path below), so the endpoint cannot redirect elsewhere. The
code in the app's URL works once, for 5 minutes, and only with the verifier
the app kept. Nelcota uses its own PKCE and `state` toward the provider and
talks to it only server to server.

## Related guides

See [JWT/roles](jwt-and-roles.md), [REST API](api.md) and [troubleshooting](troubleshooting.md).
