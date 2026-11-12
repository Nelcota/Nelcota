# Dependency maintenance

Use the checked-in lockfiles and frozen installs. Bun and Dependabot retain a
14-day release-age quarantine for ordinary updates; do not downgrade an installed
version just because `bun outdated` shows an older quarantined candidate.
Dependabot covers Cargo, Actions and all seven Bun projects, including root
tooling and both framework examples. Local `file:` SDK dependencies follow their
source packages rather than registry updates.

## Versioned patches

The root `patches/` directory contains narrow Bun patches to published npm
artifacts. Their original licenses and attribution remain in the packages.
Manifests declare `patchedDependencies`; Bun regenerates the lockfiles. Never
rely on an untracked edit in `node_modules`, a package-name substitution or a
blanket audit ignore.

### deepmerge 4.3.1

The Svelte Vite plugin uses `deepmerge` to combine trusted build configuration.
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
has no published fixed version as of November 4, 2026. Its object merge can change
the returned object's prototype when copying an enumerable own `__proto__` from
the target, or merging into a null-prototype target.

`deepmerge@4.3.1.patch` defines own data properties instead of invoking inherited
setters. It updates the source and both published CommonJS/UMD artifacts, keeping
symbol keys, cloning, custom merge behavior and Svelte's array replacement.
The panel and SvelteKit example reference the same patch. After installing both
projects, run from the root:

```sh
bun run test:dependencies
```

The tests resolve through each installed plugin, so forgetting a consumer's
patch fails. They exercise the poisoning reproductions against both artifacts.
CI also audits all seven lockfiles at the existing high-severity blocking
threshold. Unfiltered `bun audit` still reports the upstream 4.3.1 advisory:
the registry audit does not inspect local patches. Do not describe that as an
unpatched installation or a clean upstream audit. Remove the patch only after
the plugin resolves a fixed release and the regressions still pass.

### Scalar 1.76.2

The panel genuinely imports `@scalar/api-reference` from its separate
`src/reference.ts` entry; Knip lists that entry explicitly. Do not remove the
package based on the former false positive.

The exact-version Scalar patch makes hosted agent, MCP, SDK-generation and
developer-tool paths compile-time disabled in the published reference component.
The bundler then removes those render paths and lazy imports. Search, schema
rendering, localization, downloads and the interactive API client remain.
Runtime configuration still disables hosted functionality as defense in depth.
The AI packages remain in Scalar's declared install graph; they must not be
emitted into any embedded JavaScript chunk.

`scripts/reference-build.ts` checks all rendered modules, including lazy chunks,
and limits the sum of gzip level-9 sizes of the reference entry and its entire
static JavaScript import graph to 1,100,000 bytes. Shared chunks count once;
splitting the entry cannot bypass the budget. CSS, fonts and API-client code
loaded on demand are outside this startup-JavaScript budget. The reference is
still a substantial third-party application, not a small renderer.

Before updating Scalar, rebase or retire the patch, run its build-budget tests,
build the UI and run the OpenAPI browser scenario in `e2e/guides.spec.ts`.
The build must reject restored hosted modules, even if runtime flags hide them.

```sh
bun run --cwd crates/admin/ui test:build
bun run --cwd crates/admin/ui build
```

The panel's CI job runs these build-budget tests separately from its `src/`
unit tests, so the build tooling stays covered without expanding ordinary UI
test selections.

## Rust advisory exceptions

`cargo deny --locked check` enforces licenses, sources and advisories under
`deny.toml`. `.cargo/audit.toml` carries the same two documented exceptions:

- `RUSTSEC-2023-0071`: `rsa` 0.9 is used for public-key verification, never RSA
  private-key signing or decryption (D16). No fixed release is published.
- `RUSTSEC-2026-0387`: the `crypto-bigint` 0.5 chain through `p256`/`p384` verifies
  public provider signatures; local signing uses EdDSA or HS256 (D104).
  `crypto-bigint` 0.7.6 fixes the advisory but is not API-compatible with that
  dependency chain. Forcing it with an override is not a fix.

The `nelcota-auth` key tests check the actual emitted signing algorithms and
reject RSA/ECDSA local-token headers before entering those verification backends.
Reassess both exceptions before adding private RSA/ECDSA operations. Remove them
when upstream consumers move to corrected compatible dependencies. Do not rewrite
cryptographic primitives or change the static TLS provider merely to silence an
audit. Duplicate-version warnings are maintenance signals, not proof of a flaw;
prefer compatible upstream convergence over forced cross-major unification.

An audit pass with these exceptions is not a claim that the upstream packages
are vulnerability-free. Report unfiltered JavaScript advisories, local patches,
accepted Rust risks and unavailable checks separately.
