// Ready-made SQL editor templates (also listed in the command palette). The
// label and the SQL itself live in the i18n catalog, so the example table and
// column names follow the panel language: render them with `t()`.

import type { MessageKey } from "$lib/i18n/index.svelte";

export interface SqlSnippet {
  label: MessageKey;
  sql: MessageKey;
}

const snippet = (
  id: "rlsTable" | "tablesWithoutRls" | "recentUsers" | "slowQueries",
): SqlSnippet => ({
  label: `sql.snippets.${id}.label`,
  sql: `sql.snippets.${id}.sql`,
});

export const SQL_SNIPPETS: readonly SqlSnippet[] = [
  snippet("rlsTable"),
  snippet("tablesWithoutRls"),
  snippet("recentUsers"),
  snippet("slowQueries"),
];
