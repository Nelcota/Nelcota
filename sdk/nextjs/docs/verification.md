# Verification of @nelcota/nextjs

What the adapter's tests and smokes cover, the dated evidence behind released
versions and the gates that remain open. Commands are in the
[README](../README.md#local-verification); the CI workflow is described in
[releasing](releasing.md).

## Publication receipts

- `@nelcota/nextjs` [0.1.2](https://github.com/Nelcota/Nelcota/pull/181#issuecomment-6423930169)
  (October 26 receipts, with TypeScript 0.2.4 and Rust 0.1.7).
- `@nelcota/client` [0.2.5](https://github.com/Nelcota/Nelcota/pull/202#issuecomment-6445288705)
  and `@nelcota/ssr` [0.1.0](https://github.com/Nelcota/Nelcota/pull/203#issuecomment-6446199815)
  (October 27 receipts).
- Earlier base SDK receipts: [TypeScript 0.2.3 and Rust 0.1.6](https://github.com/Nelcota/Nelcota/pull/167#issuecomment-6391372294).
- [Publication and acceptance](https://github.com/Nelcota/Nelcota/issues/151)
  records the original validation, published 0.1.1 with its PostgreSQL
  contention correction, and the explicitly skipped external provider gates.

## Concurrent sign-ins and lineages

Tests cover memory and PostgreSQL stores (mocked pool with two store instances,
and real PostgreSQL with two pools/instances): reordered responses for
different and identical users, publication withheld for a later winner, a
delayed sign-out with an older cookie, no clearing by stale requests, the
proxy bootstrap, and the cookie-less residual. The production framework smoke
uses two Next processes and a shared disposable PostgreSQL store. Two tabs
with one cookie jar sign in concurrently after loading the bootstrap path.
Reversed or lost replies leave the browser signed out; natural order shows the
newer identity. The next lineage sign-in retires a lost winner. WebKit's
provisional intercepted requests omit Cookie, so their controlled replay uses
the browser's cookie jar for that exact URL. Tabs that skip bootstrap retain
the cookie-less residual described in the README. These checks run in the
documented browser and Node matrix; the execution ledger retains each artifact
and result.

## Framework and boundary smokes

The boundary and framework smokes link the package into its own
`node_modules` (so the example shares one `next`/`react`) and run a production
build of the example. Set `NELCOTA_NEXT_BROWSER=firefox` or `webkit` to select
another installed Playwright engine; Chromium is the default. `CHROMIUM_PATH`
optionally overrides its executable. The framework smoke starts two `next start`
processes sharing PostgreSQL against a local transport fixture: it is not RLS
evidence. It exercises password, signup/confirmation, resend, user update,
refresh, recovery, magic links and OAuth callbacks, including replay rejection.
The example's `/api/auth` POST handler demonstrates these operations without
returning session tokens. Email-link tokens belong in the POST body.

## Real auth and email contract

After building the server and both SDK packages, run the real auth/email
contract from the repository root:

```sh
bun sdk/typescript/scripts/contract.ts --nextjs test/contract/auth.test.ts
```

This owns disposable PostgreSQL and STARTTLS Mailpit fixtures, tests real
recovery/magic-link delivery and token consumption, and verifies eight
concurrent refresh contexts through independent session stores. The reusable
Next verification workflow runs these checks and the server OAuth contract; the
SSR core workflow (`sdk-ssr-check.yml`) runs the backend matrix and storage/S3
smokes. Both run before release publication.

## Storage redirects

Unit tests and a real loopback HTTP redirect cover the redirect policy. On
2026-10-24, `scripts/storage-smoke.mjs` (now `sdk/ssr/scripts/storage-smoke.mjs`) ran a current-source Nelcota server on
the S3 backend against a loopback RustFS 1.0.1 provider, the S3-compatible
service CI uses. MinIO community binaries are no longer distributed. The API
answered 302 to a presigned provider URL. With the provider origin listed, the
download returned the uploaded bytes and a range request returned 206. Only
allow-listed headers reached the provider, with no `Authorization`, cookie or
`apikey`. Without the option, or with another origin listed, the result was
`storage_redirect_refused` and the provider was never contacted.

The smoke creates and removes its own bucket on the disposable provider through
a minimal SigV4 client (`sdk/ssr/scripts/storage-provider-smoke.mjs`); the provider's
bucket API requires signed requests, so that client is fixture setup, not SDK
code.

## Earlier Next major

Up to 0.1.x a pinned Next 15.5.28 consumer passed all three browsers on Node 24
with PostCSS 8.5.31, TypeScript 6 and Node middleware adaptations
([evidence](https://github.com/Nelcota/Nelcota/blob/main/docs/goals/nextjs-151-validation.md)).
The peer range never included Next 15, so that consumer was removed from CI;
earlier majors are untested and unsupported.

## Open gates

Live Google/GitHub accounts and AWS S3/R2 HTTPS remain explicitly unvalidated
at the maintainer's request. Controlled provider endpoints and loopback RustFS
checks do not complete those gates. AWS S3, R2 and other providers, and HTTPS
storage endpoints, were not exercised.
