# Examples

Use these examples with a disposable project and a user account. The backend
needs no Node runtime; JavaScript clients use their own tooling. Start with
[the local quickstart](../docs/quickstart.md).

## Shared schema

Apply `notes.sql` as database owner through the SQL editor, or copy it to the
next unused `V<n>__notes.sql` in your app migrations and run `nelcota migrate`.
It creates `notes` with `extra` and a private `files` bucket/policy. Both SDKs
use this schema. `CREATE TABLE IF NOT EXISTS` does not add missing columns;
add them in a new migration for an existing table.

Never edit an applied migration or use Nelcota's internal migrations as app
SQL. Schema setup is privileged; client requests use a user's token under RLS.

## JavaScript and TypeScript

This checkout documents `@nelcota/client@0.2.1`; registry installation requires
that version to be published. See the [upgrade notes](../sdk/typescript/docs/contract.md#upgrading-from-020). For checkout demos, enter
`sdk/typescript`, run `npm ci` and `npm run build`, then:

```sh
npm run example:browser
```

Open the displayed loopback page, set the API origin and sign in. For Node,
set `NELCOTA_URL`, `NELCOTA_EMAIL` and `NELCOTA_PASSWORD` privately and run
`node examples/node.mjs`. `NELCOTA_SIGN_UP=1` creates a development account;
email-confirming projects require confirmation before the demo can proceed.

`sdk/typescript/examples/server.mjs` validates Bearer syntax and creates a
client per incoming request. It demonstrates identity forwarding, not a complete
production web framework/CSRF/session configuration.

The Todo demo uses [todos.sql](todos.sql) and [sdk-todos.mjs](sdk-todos.mjs).
Copy `sdk-todos.mjs` into a consumer directory and install the package there;
Node resolves imports from the script location, not just your working directory.
The root checkout does not install `@nelcota/client`. It leaves a development account and Todo
rows, so use a disposable project without email confirmation.

## Rust

Use Rust 1.88+ for a registry consumer or the pinned workspace toolchain for
checkout examples. Set `NELCOTA_URL`, `NELCOTA_EMAIL` and `NELCOTA_PASSWORD`
for an existing user (or `NELCOTA_ACCESS_TOKEN`), then run from the repository:

```sh
cargo run --locked -p nelcota-client --example rest
cargo run --locked -p nelcota-client --example storage
```

The REST example accepts password credentials or an access token. The storage
example specifically requires `NELCOTA_URL`, `NELCOTA_ACCESS_TOKEN` and
`NELCOTA_UPLOAD_PATH`; it leaves the uploaded `demo.txt` in the user folder. The OAuth example needs an enabled
provider and `NELCOTA_OAUTH_REDIRECT_URL` in the allowlist. Keep its verifier
private. `https_smoke` makes an anonymous external HTTPS request; it does not
validate your own deployment or replace real-server contracts.

## Standalone authentication

[auth-consumer](auth-consumer/README.md) embeds auth without full-server
capabilities. Its source/archive workflow has separate bootstrap/role and
shutdown requirements.

## Troubleshooting

A missing `extra` means the full Notes schema was not applied. Empty rows can
be RLS filtering another user's data. Check disk storage, the private `files`
bucket and a user-ID-prefixed path for file failures. Source-only changes need
a newly built/installed package.

> **Warning:** Never put `service_role`, deployment secrets or signing keys in
> browser/mobile examples.

Related: [SDK contract](../sdk/typescript/docs/contract.md),
[Rust contract](../sdk/rust/docs/contract.md) and [troubleshooting](../docs/troubleshooting.md).
