// What the SQL editor keeps in this browser only for the session: executed
// statements and open drafts. They can hold passwords or keys, so a session
// end forgets them. Saved queries are kept on purpose and are not listed here.
// Kept apart from the store so startup can check and clear them without
// loading the editor.

import { readText, remove } from "$lib/browser/local-storage";

/** Pre-workspace single draft; read once to migrate, never written. */
export const DRAFT_KEY = "nelcota:sql-draft";
export const HISTORY_KEY = "nelcota:sql-history";
export const WORKSPACE_KEY = "nelcota:sql-workspace";

const SESSION_KEYS = [HISTORY_KEY, WORKSPACE_KEY, DRAFT_KEY] as const;

/** Whether this browser still holds SQL history or drafts. */
export function hasSessionWork(): boolean {
  return SESSION_KEYS.some((key) => readText(key, "") !== "");
}

/** Removes the stored SQL history and drafts; saved queries stay. */
export function forgetSessionWork(): void {
  for (const key of SESSION_KEYS) remove(key);
}
