# JWT and roles

Public contract. The JWT format is ours and documented here; no library
dictates it.

## Prerequisites

You need an initialized private PostgreSQL database and a signing key or
compatible verifier. This page describes built-in token/role behavior; issuer
and audience policy are not enforced by the built-in verifier.

## Postgres roles

| Role            | Login | Used by                            | RLS        |
|-----------------|-------|------------------------------------|------------|
| `authenticator` | yes   | the API connection (pool)          | n/a        |
| `anon`          | no    | requests without `Authorization`   | enforced   |
| `authenticated` | no    | signed-in end users                | enforced   |
| `service_role`  | no    | trusted backend                    | **bypassed** (`BYPASSRLS`) |
| `nelcota_auth`  | no    | internal: the server reading `auth.*` | n/a (no JWT can assume it) |

`authenticator` is `NOINHERIT`: on its own it has no privilege at all. It is a
member of the other roles and assumes one of them in each request.

> **Warning:** **A JWT with `role: service_role` bypasses all RLS. It must
> NEVER go to the frontend, a mobile app or anywhere outside your server.**

## What happens in each request

1. The API reads `Authorization: Bearer <jwt>` (the scheme is case-insensitive:
   `bearer <jwt>` works too).
   - Without the header: the request becomes `anon`.
   - Header present but invalid (signature, `exp`, `nbf`, `iat`, scheme, unknown `kid` or
     role): **401**. It never silently becomes `anon`.
2. Opens **one** transaction and runs, with parameters:
   ```sql
   SELECT set_config('role', $1, true),                -- = SET LOCAL ROLE
          set_config('request.jwt.claims', $2, true);  -- full claims
   ```
3. Runs the query. Postgres RLS decides what the role sees.
4. COMMIT (or ROLLBACK on error). Role and claims die with the transaction.

Application row access is determined by PostgreSQL GRANTs and RLS. The server
also validates authentication, query/path syntax and operation boundaries before
executing the request.

## Signing

- **EdDSA (Ed25519)**, the default. Private key in `NELCOTA_JWT_PRIVATE_KEY`
  (PKCS#8 in PEM, or the one-line base64). The public key is published at
  `GET /auth/v1/.well-known/jwks.json` (`kty: OKP`, `crv: Ed25519`, `kid` =
  RFC 7638 thumbprint). Each token's header carries the `kid`.
- **HS256**, the simple/legacy mode, with `NELCOTA_JWT_SECRET` (≥ 32
  characters). When there is an EdDSA key, the HS256 secret is only used to
  **verify** old tokens, which allows migrating without signing anyone out.

Generate a key: `openssl genpkey -algorithm ed25519` (or `nelcota init`, which
generates one).

## Claims of user tokens (issued by `/auth/v1`)

```json
{
  "iss": "nelcota",
  "aud": "authenticated",
  "sub": "3f1c…-uuid",
  "role": "authenticated",
  "email": "ana@example.com",
  "session_id": "8a2d…-uuid",
  "iat": 1767225600,
  "exp": 1767226500
}
```

## Validation rules (any issuer)

| Claim  | Required | Rule |
|--------|----------|------|
| `role` | yes | `anon`, `authenticated` or `service_role`. Any other value → 401. |
| `sub`  | only for `authenticated` | the user's uuid (`auth.uid()`). |
| `exp`  | yes | epoch in seconds; 30 s of leeway. |
| `nbf`, `iat` | no | if present, whole non-negative epoch seconds; reject values more than 30 s in the future. |
| `iss`, `aud` | no | informative: not required or matched by verification. |

The same built-in `Keys` validator checks EdDSA and HS256 API tokens and signed
raw payloads. Standalone auth consumers inherit these checks. The Rust and
TypeScript SDKs forward tokens to the server; they do not verify signatures or
make authorization decisions from decoded claims. Keep issuer/audience policy
in a custom verifier when required; `iss`/`aud` remain informative.

Other claims are passed through untouched to `auth.jwt()`. Logout revokes the
session and the refresh tokens; the access JWT, which is stateless, stays valid
until `exp` (default: 15 minutes, `NELCOTA_JWT_EXPIRY_SECS`).

## Switching auth providers

Since policies only depend on `auth.uid()`, `auth.role()` and `auth.jwt()`,
any issuer producing a JWT with the claims above works. Verification sits
behind the `JwtVerifier` trait; accepting an external JWKS (Auth0, Keycloak,
Zitadel...) is a new implementation of that trait.

## SQL functions

```sql
auth.jwt()  -> jsonb  -- request claims ('{}' outside a request)
auth.uid()  -> uuid   -- the sub claim
auth.role() -> text   -- the role claim
```

Policy example:

```sql
CREATE POLICY owner ON public.todos
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());
```

## HTTP status codes

| Situation | Status |
|---|---|
| Invalid or expired JWT, unknown role or a scheme other than Bearer | 401 `invalid_token` |
| `anon` without permission on the table | 401 `db_error` (`sqlstate` `42501`) |
| `authenticated` without permission / policy violated on write | 403 `db_error` (`sqlstate` `42501`) |
| Table does not exist | 404 `not_found` |

The body is the API's error JSON (`code`, `message` and, for database errors,
`sqlstate`/`details`/`hint`/`constraint`); see [api.md](api.md#errors).

Every 401 carries `WWW-Authenticate`: `Bearer error="invalid_token"` when a
token was presented and rejected, plain `Bearer` when the request had no
token (an `anon` request that needs to sign in).

## Related guides

See [auth schema](schema-auth.md), [REST API](api.md) and [deploy](deploy.md).
