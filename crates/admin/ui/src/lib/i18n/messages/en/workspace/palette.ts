// Command palette (Ctrl/⌘ K). The `keywords` prefix each item's search text,
// so typing "table" or "tabela" finds tables in the matching language.
import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/workspace/palette";

const en: Messages<typeof ptBR> = {
  title: "Command palette",
  description: "Search pages, tables, queries and actions",
  placeholder: "Search pages, tables, queries…",
  empty: "Nothing found. Try another page, table or query name.",
  view: "view",
  hints: { move: "move", open: "open", close: "close" },
  groups: {
    pages: "Pages",
    tables: "Tables",
    saved: "Saved queries",
    templates: "SQL templates",
    actions: "Actions",
  },
  keywords: {
    page: "page",
    table: "table",
    query: "query",
    template: "template",
  },
  actions: {
    theme: "Toggle theme",
    themeKeywords: "action toggle theme light dark",
    docs: "Open the API documentation",
    docsKeywords: "action documentation api openapi",
    signOut: "Sign out",
    signOutKeywords: "action sign out logout",
  },
};

export default en;
