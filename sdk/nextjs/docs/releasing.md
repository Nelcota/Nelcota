# Releasing @nelcota/nextjs

The package has independent semver and requires the published
`@nelcota/client` 0.2.2 or later. Verify the registry prerequisite with
`npm view @nelcota/client@0.2.4 version`; 0.2.4 is the current published base
used by the examples. The minimum peer remains 0.2.2.

## Verification

`.github/workflows/sdk-nextjs-check.yml` is shared by PR CI and tagged releases.
It runs unit/real PostgreSQL tests and external packed consumers on Node
22/24/26, production Next and Chromium on those runtimes, and Firefox/WebKit on
Node 24. It also checks the server-only bundle boundary, two Next processes
sharing PostgreSQL, the auth-flow matrix, repeated-request lock cleanup, real
backend RLS, STARTTLS email delivery, the Next SDK's real-backend OAuth contract and RustFS
storage redirects. All jobs must pass on the released commit.

Local commands are listed in the README. Keep Rust tests, Vitest and dependency
audits sequential. Use only disposable fixtures. The auth fixture is started
with `bun sdk/typescript/scripts/contract.ts --nextjs test/contract/auth.test.ts`
after building the base SDK, Next package and server binary. Its Next consumer
uses actual recovery/magic-link emails and refresh rotations. The production
Next callback also runs against a local auth transport fixture. The explicitly
selected Rust integration case `nextjs_sdk_finishes_a_real_pkce_flow -- --ignored`
runs the Next SDK through the real backend's authorization/callback/PKCE routes
with local GitHub token/profile endpoints. Live Google/GitHub accounts are not
required and are not claimed as tested.

## Initial npm access

This package needs its own npm publishing access and trusted publisher; the
base SDK's npm configuration does not configure `@nelcota/nextjs` automatically.
Authenticate as a maintainer of the `@nelcota` scope (`npm login`, `npm whoami`).
Never put registry credentials in repository files or workflow logs.

For the initial publication, use `npm publish --access public` from `sdk/nextjs`
only after the final commit passed the complete verification workflow. Inspect
`npm pack --dry-run` first. Configure npm trusted publishing for owner `Nelcota`,
repository `Nelcota`, workflow `sdk-nextjs-release.yml`, environment `npm`.
The GitHub `npm` environment must allow deployment from the tag pattern
`nextjs-sdk-v*`; retain the base SDK's separate `sdk-v*` rule.
With a current npm CLI, configure it after the package exists:

```sh
npm trust github @nelcota/nextjs --file sdk-nextjs-release.yml \
  --repo Nelcota/Nelcota --env npm --allow-publish
npm trust list @nelcota/nextjs
```

See the [official npm instructions](https://docs.npmjs.com/trusted-publishers/)
for account requirements and configuration expiry.

## Tagged releases

1. Update package/lock versions, the dated changelog and compatibility evidence.
2. Merge the reviewed change after all CI jobs pass.
3. Tag that exact commit `nextjs-sdk-v<version>` and push the tag.
4. The workflow verifies the tagged source before the OIDC publish job. Existing
   published versions are skipped, never overwritten.
5. Check the publish result and `npm view @nelcota/nextjs@<version> version`.
   Install the registry package in a fresh consumer before announcing it.

Failed verification keeps publication blocked. A green verification job is not
proof of registry publication. Fix a published defect in a new patch version.
