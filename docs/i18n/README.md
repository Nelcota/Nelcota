# Guide translations

The panel bundles the original project and SDK documentation and translates
prose when Portuguese is selected. The guide registry is in
`crates/admin/ui/src/lib/features/guides/registry.ts`; each English guide has a
matching `pt-BR/<guide-id>.json` catalog. Portuguese quickstarts and standalone
code examples already come directly from their source files.

Catalog keys are exact source Markdown fragments: headings, paragraphs, list
items and table cells. Values are their Portuguese translations. The reader
translates the parsed document, retaining fenced/indented code, comments in
examples, inline code, link destinations and source-language section IDs.
Code-only source changes therefore appear immediately in the next build.

From `crates/admin/ui`, run `bun run guides:pending` to list missing prose.
Translate the changed fragments and remove obsolete keys. Keep inline code and
link destinations intact; sentence order and link labels may change.
`bun run guides:check` rejects missing/obsolete prose or changed inline code and
links. Both `bun run check` and `bun run build` include this check, including CI.
Unit tests also compare all code examples, destinations and heading IDs.

For a new catalog, `node scripts/guides-i18n.mjs --extract <id>` lists all
fragments. Create a JSON array of translations in that order, then run
`node scripts/guides-i18n.mjs --import <id> /path/to/translations.json` to validate
and save the catalog.

`pt-BR/openapi.json` tracks the standard prose emitted by
`crates/api/src/openapi.rs`, including its format templates. The check rejects
changes without matching translations. The reference localizes this prose and
Scalar's interface only for display; the panel's download keeps the original
OpenAPI JSON. User-authored database comments, schemas and examples stay intact.

The English source is canonical for guide prose. Standalone pt-BR quickstarts
must also track release/source distinctions; catalog validation alone cannot
prove their factual accuracy. New repository references do not become panel
guides until registered. Rebuild embedded assets after changing registered
sources or catalogs, following the separate build-commit rule in CONTRIBUTING.md.
