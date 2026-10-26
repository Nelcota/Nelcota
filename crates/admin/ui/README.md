# Nelcota panel

SPA in Svelte 5 + shadcn-svelte + Tailwind v4 + CodeMirror 6, built with Vite.
`dist/` is committed and embedded in the binary by the `nelcota-admin` crate.

```sh
bun install --frozen-lockfile
bun run dev     # http://127.0.0.1:5173/admin/ (API: http://127.0.0.1:8000)
bun run check
bun run build   # updates dist/: commit changed output in a separate commit
```

Each `src/lib/features/<feature>/` contains the feature's pages, state, API
adapter, helpers, components and adjacent unit tests. Use relative imports
inside the feature and `$lib/...` for dependencies outside it.

The application frame, navigation and command palette live in `src/lib/shell`.
Reusable panel components live in `src/lib/components/shared`; shadcn-svelte
primitives stay in `src/lib/components/ui`. Shared table/policy metadata and
DDL previews live in `src/lib/shared/schema`. Transport, resources,
navigation, browser effects, forms and formatting live in their owner
directories under `src/lib/` (`browser/local-storage.ts` handles browser
persistence; `features/storage` owns server files). See the ownership map in
[architecture](../../../docs/architecture.md#source-organization).

Wire types and validators in `src/lib/generated` come from Rust DTOs. Import
the generated types through `$lib/contracts/types` rather than declaring another copy.
Panel texts live in `src/lib/i18n/messages` (pt-BR and English).

Use Node 24 for repository tooling and start the native backend first. Override
Vite's target with `NELCOTA_API_URL`. Regenerate wire types with `bun run contracts`;
check guide catalogs with `bun run guides:check`. After UI or bundled-doc changes,
build, commit `dist` separately and rebuild the Rust binary. See the repository's
CONTRIBUTING.md for targeted unit/browser and cancellation/GC checks.
