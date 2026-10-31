# Code quality standards

Nelcota adopts the JavaScript and TypeScript checks from
[NelcotaRules](https://github.com/Nelcota/NelcotaRules), reviewed at commit
`453f453d66f1f7e282b9677c1d70ca091da9bd02`. The source repository remains the
upstream reference. Local adaptations account for the Rust backend, Svelte UI
and independently distributed SDK packages.

## Tool ownership

The root `package.json` owns development-only Oxlint, Oxfmt, Prettier with its Svelte plugin, Knip, the local rule
plugins and their tests. Install with `bun install --frozen-lockfile --ignore-scripts`.
The full typed check also needs the database types emitted by the existing
SDK contract fixture (`bun run --cwd sdk/typescript test:contract`), using an
owned disposable database and the real CLI generator. Regenerate them after
changing the fixture or type generator. CI transfers this exact artifact from
the successful contract job instead of using hand-written schema stubs.

Run `bun run check` from the repository root. Its preparation step installs the
UI, SDK and SvelteKit example dependencies from their lockfiles, builds the client
before refreshing its local `file:` consumers, then builds SSR and Next.js. It
also links the Next.js example to the checkout. These dependencies are copied
at installation time; an old installed copy does not validate a newly changed
public API. The checks run sequentially and leave build outputs ignored.

The SvelteKit example pins the TypeScript 6 compiler API through its `typescript`
alias. SvelteKit reads checked JavaScript configuration through that API; the
TypeScript 7 CLI package does not provide it. The root checks use the separate
`typescript-7` alias for static validation.

The root `.nelcota-rules.oxlintrc.json` runs the complete profile, including
JavaScript plugins and type-aware rules. The existing `.oxlintrc.json` and
`oxlint-presets/` remain the native lint presets used by the existing Rust/UI
workflows. A native Oxlint binary alone cannot replace the root check: it does
not execute the JavaScript plugins.

- `bun run lint` checks the UI, SDKs, examples, scripts and local rules.

The root lint driver also checks component scripts through virtual TypeScript
produced by the pinned official `svelte2tsx` compiler. Oxlint's native Svelte
support does not currently execute its type-aware rules. A temporary source
mirror preserves real imports, aliases and compiler shims; source maps return
findings to the original scripts, including UTF-8 locations. Generated template
scaffolding is excluded from this pass; the strict Svelte compiler continues to
check templates. Derived expressions are modeled as deferred callbacks, matching
their reactive evaluation. Only the compiler's untyped `$props()` value and empty
`$bindable()` defaults inside explicitly typed props are excluded from unsafe
assignment diagnostics. Unrelated unsafe values still fail. Regression tests
exercise these boundaries, reactive conditions, malformed components and module
collisions. Temporary files are removed even when compilation or linting fails.

- `bun run typecheck:rules` checks the rule tooling itself.
- `bun run typecheck:scripts` checks JavaScript with JSDoc and `checkJs`, plus
  the existing TypeScript maintenance scripts. Build all SDKs first.
- `bun run format:check` checks Oxfmt's supported source formats and formats Svelte
  components with the pinned Prettier Svelte plugin.
- `bun run knip` checks the complete module graph, including Svelte scripts,
  template references, CSS imports, package export maps and explicit test entries.
- `bun run package-size` checks each source folder independently, across all
  four packages and the root lint tooling. Generated contracts are excluded.
- `bun run test:rules` tests the custom checks without downloading tooling.

Rust formatting, Clippy, contracts, documentation boundaries and the established
resource limits remain part of repository validation. Run suites sequentially;
follow `AGENTS.md` and `CONTRIBUTING.md` for the shared PostgreSQL fixture.

## Source conventions

Use explicit boolean and null comparisons, early returns, checked array access
and validated `unknown` values. Do not introduce `any`, non-null assertions,
skipped/focused tests, raw HTML insertion or unnamed timer units. Keep modules
in the feature that owns them and use kebab-case filenames. Split large modules
and folders by responsibility. Preserve ordering when an asynchronous operation
depends on the previous operation.

Document exported TypeScript behavior using TSDoc without repeating the types.
Generator documentation also uses the lint profile's `@yields` block to describe
the rows yielded by each iteration.
JavaScript stays in `.js`/`.mjs` and uses JSDoc types checked by TypeScript.
Avoid suppression comments that conceal violations. Changes to generated Rust
contracts must go through their generator; released SQL migrations and historical
evidence are immutable.

## Repository adaptations

Vitest remains the existing UI/SDK test runner. The imported profile therefore
allows Vitest imports; the local skip/focus rule applies to both Vitest and
Bun tests. Relative imports follow the existing architectural boundary checker
rather than an arbitrary count of parent-directory segments. The upstream magic-number
exception for tests also covers this repository's `.spec`, `.test-d`, memory
and smoke suites, including test and browser fixture helpers; type and timer-unit
checks still apply to them. Runtime SDK
compatibility continues to include supported Node versions and web runtimes.
The tooling does not install global hooks or change the user's Git configuration.

Narrow inline exceptions preserve tested contracts. Cancellation and adapter
wrappers forward the original rejection, including non-`Error` values; replacing
it would change error identity. Browser instrumentation deliberately saves a
method and calls it with `.call(this)`, preserving the receiver. Each exception
names its rule and reason. Cancellation propagation is covered by the SDK's
`cancellation.test.ts` and related abort tests; native-method instrumentation is
exercised by the browser storage, preview and upload regressions.

Dependent asynchronous loops also retain narrow `no-await-in-loop` exceptions:
stream reads enforce byte budgets; retries honor the prior failure and delay;
pagination advances from accepted results; uploads and deletion batches preserve
partial-failure ordering; keyring setup preserves the primary key and first error;
lock cleanup stops at lost ownership; memory probes settle each cancellation and
GC turn. Each affected statement explains its ordering requirement. Their existing
stream, retry, pagination, upload, keyring, session-store and memory tests remain
part of validation. Browser scenarios also retain statement-level exceptions where
one page interaction depends on the preceding navigation, cookie or form state.
Database and provider fixtures preserve transaction, mutation and cleanup order;
readiness loops wait between attempts; chunk inspection reads one file at a time
to bound memory. These exceptions remain visible at each awaited statement and do
not disable the rule for a file or test directory. Independent cases use parameterized
tests or bounded concurrency instead.

Tests requiring an external facility have explicit commands. The UI memory test
runs with `bun run test:memory` under Node with exposed GC. SSR's PostgreSQL
suite runs with `bun run test:integration` or `bun run test:integration:node` and
requires `NELCOTA_SSR_TEST_DATABASE_URL` (the older
`NELCOTA_NEXT_TEST_DATABASE_URL` is still accepted); without it the suite is
skipped locally with a message and fails in CI. Selecting any other contract
without its prerequisites fails immediately. The deferred live OAuth/provider acceptance
work in issue #151 remains pending; local fixtures do not satisfy it.

## Query execution

REST query builders are not `PromiseLike`: their deprecated `then` member only
rejects with a usage error, so an accidental `await` fails loudly. Explicitly call
`.execute()` before awaiting, returning a request promise or including a query
in `Promise.all`. Authentication, storage and RPC methods already return
promises; their calls keep their existing execution behavior.

```ts
const query = client.from("notes").select("id,body");
const result = await query.execute();
```

Untyped clients expose row values as `unknown`. Validate these values before
using them, or pass the generated `Database` type to `createClient`. This is a
breaking API change intended for the next compatible release boundary; it does
not authorize publishing any package.
