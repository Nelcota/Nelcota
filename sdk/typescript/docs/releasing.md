# Releasing @nelcota/client

The release workflow validates the tagged commit against the real server before
publishing. Its reusable verification job runs the same package, runtime and
browser checks as pull-request CI. A failing check prevents the publish job.

## Local candidate

From `sdk/typescript`:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run test:types
bun run build
bun run size
npm run test:package
bun run test:runtime
cargo build -p nelcota-server
bunx playwright-core install chromium firefox webkit
bun run test:contract -- --browser
npm pack
```

Set `NELCOTA_SDK_BROWSERS=chromium,firefox,webkit` to run all browser engines
locally. The default contract run uses Chromium. Bun and Deno smoke commands are
listed in the README. `npm pack` builds first, and the tarball contains only
compiled code, declarations, license, docs and examples. Inspect the candidate
with `npm pack --dry-run` before publishing.

## npm account setup

The maintainer needs access to the `@nelcota` scope. Authenticate locally with
`npm login` and verify with `npm whoami`; never put a token in this repository.
If npm does not yet expose package settings, complete the initial authenticated
publish of the validated candidate before configuring subsequent OIDC releases.
Use `npm publish --access public` from this directory for that first publish.
The publication hook runs local checks; the integration gate must also have
passed for the same source before this manual bootstrap.

Configure npm trusted publishing using:

- Owner: `Nelcota`
- Repository: `Nelcota`
- Workflow filename: `sdk-release.yml`
- Environment: `npm`

The GitHub-hosted publish job uses `id-token: write`, not a stored npm token.
See the [official trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/)
for current account/setup requirements. Configure it when ready to publish:
new configurations require a first successful publish within two days.

## Versioned release

1. Update `package.json` and the lockfile version, and add a dated changelog
   entry. Keep server compatibility accurate; do not infer it from SemVer alone.
2. Commit the reviewed SDK and workflow changes. Run/inspect CI on that commit.
3. Create `sdk-v<package version>` on that commit and push the tag. The workflow
   checks that the tag matches package.json, verifies the commit and publishes.
4. Confirm the workflow's publish succeeded and `npm view @nelcota/client version`
   returns the new version. Install it in a fresh consumer before announcing it.

Do not overwrite a published version. Fix a bad release with a new patch version
and, when appropriate, deprecate the bad version with a concrete migration note.


Historical-server compatibility is a separate gate. The current contract runner
builds `sdk-contract-server` from this checkout; `NELCOTA_BIN` selects the CLI
used for fixture commands and does not replace that HTTP server. Do not count a
run with an older CLI as validation of an older server. Run the consumer against
an actual isolated server at each claimed baseline and record its version/digest,
fixture and capability coverage before making a broader compatibility claim.
