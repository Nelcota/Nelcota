# Leaving Nelcota (no lock-in)

Export your schema, policies, identities and files to another backend. You need
owner access, PostgreSQL tools and a verified destination. Database metadata is
SQL; file bytes and deployment secrets must be exported separately. Completion
time depends on dataset size and destination compatibility.

For the Docker commands below, enter `projects/<name>/` inside your host folder
so Compose selects that project. Systemd hosts use native PostgreSQL tools.
Keep dumps, user/password-hash exports, file mappings and configuration private.

## 1. The whole database (schema, data, policies, functions, users)

```sh
docker compose exec -T postgres pg_dump -U postgres -Fc postgres > nelcota.dump
# restore into any Postgres 17+:
pg_restore --no-owner -d "postgres://user@new-host/db" nelcota.dump
```

The roles `anon`, `authenticated`, `service_role`, `authenticator`,
`nelcota_auth`, `nelcota_storage` and `nelcota_webhooks` are global and not part
of `pg_dump`. Create them on the target first; the role blocks in
`migrations/V1__roles_e_auth.sql`, `V2__auth_usuarios_e_sessoes.sql`,
`V8__storage.sql` and `V13__webhooks.sql` are idempotent. `pg_restore --no-acl`
skips grants only: policies that name these roles still need them.

## 2. Just the users (with their hashes)

```sh
docker compose exec -T postgres psql -U postgres -c "COPY (
  SELECT id, email, encrypted_password, email_confirmed_at,
         raw_user_meta_data, created_at, last_sign_in_at
  FROM auth.users) TO STDOUT WITH CSV HEADER" > users.csv
```

`encrypted_password` uses the standard PHC argon2id format
(`$argon2id$v=19$m=19456,t=2,p=1$...`). Any argon2 library verifies these
hashes without conversion: users **do not need to change their passwords**.
Details in [schema-auth.md](schema-auth.md).

## 3. The JWTs

The format is in [jwt-and-roles.md](jwt-and-roles.md). To switch auth
providers without rewriting the policies, the new provider only has to issue
tokens with `role` and `sub`. The `auth.uid()`/`auth.jwt()` functions stay the
same.

## 4. The files

`storage.objects` is part of the dump above. The bytes are plain files in
`projects/<name>/storage/` (disk) or objects in your own bucket (S3), stored
as `<bucket>/<version>`. The name of each one:

```sh
docker compose exec -T postgres psql -U postgres -c "COPY (
  SELECT bucket_id || '/' || version AS key, bucket_id || '/' || name AS name
  FROM storage.objects) TO STDOUT WITH CSV HEADER" > files.csv
```

## 5. What stays behind

Only the `nelcota` binary: the automatic REST API and the panel. Without
Nelcota, Postgres keeps serving exactly the same data with the same policies,
and you can point PostgREST, Hasura or your own backend at it.
