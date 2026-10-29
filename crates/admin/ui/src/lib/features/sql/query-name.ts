import { t } from "$lib/i18n/index.svelte";

import { queryTitle } from "./query-title";

/**
 * The name an unsaved query shows in lists and the toolbar: what it does
 * ("Query on orders") when that can be read, else its first line, which still
 * tells drafts apart.
 */
export function draftName(sql: string): string {
  const title = queryTitle(sql);
  if ("target" in title) return t(`sql.title.${title.kind}`, { target: title.target });
  if (title.kind === "empty") return t("sql.title.empty");
  const [first = ""] = sql.trim().split("\n");
  return first;
}
