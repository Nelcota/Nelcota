// SQL editor state: draft, history and saved queries. Lives outside the
// component so the command palette can open a query in the editor.
// Persisted in the browser (per project, since each panel has its own origin).

import { newId } from "$lib/browser/id";
import { readJson, readText, write } from "$lib/browser/local-storage";

import { requiredValue } from "../../contracts/required-value.js";
import { DRAFT_KEY, HISTORY_KEY, WORKSPACE_KEY, forgetSessionWork } from "./session-work";

const SAVED_KEY = "nelcota:sql-saved";
const HISTORY_LIMIT = 20;
const DEFAULT_DRAFT = "select now();";

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  updatedAt: number;
}

export interface SqlDraft {
  id: string;
  queryId: string | null;
  sql: string;
}

interface Workspace {
  v: 1;
  active: string;
  items: SqlDraft[];
}

function parseWorkspace(value: unknown): Workspace | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || typeof raw.active !== "string" || Array.isArray(raw.items) === false)
    return null;
  const items = raw.items.filter((item: unknown): item is SqlDraft => {
    if (item === null || typeof item !== "object") return false;
    const draft = item as Record<string, unknown>;
    return (
      typeof draft.id === "string" &&
      typeof draft.sql === "string" &&
      (draft.queryId === null || typeof draft.queryId === "string")
    );
  });
  return items.some((item) => item.id === raw.active) ? { v: 1, active: raw.active, items } : null;
}

const workspace = readJson<Workspace | null>(WORKSPACE_KEY, parseWorkspace, null);

const isSaved = (item: unknown): item is SavedQuery =>
  typeof item === "object" &&
  item !== null &&
  typeof (item as SavedQuery).id === "string" &&
  typeof (item as SavedQuery).name === "string" &&
  typeof (item as SavedQuery).sql === "string" &&
  typeof (item as SavedQuery).updatedAt === "number";

// Versioned format: `{ v: 1, items }`, so it can be migrated later.
const parseSaved = (data: unknown): SavedQuery[] | null =>
  typeof data === "object" && data !== null && (data as { v?: unknown }).v === 1
    ? (((data as { items?: unknown }).items as unknown[] | undefined)?.filter(isSaved) ?? [])
    : null;

const parseHistory = (data: unknown): string[] | null =>
  Array.isArray(data) ? data.filter((h): h is string => typeof h === "string") : null;

class SqlStore {
  drafts = $state<SqlDraft[]>(
    workspace?.items ?? [{ id: "scratch", queryId: null, sql: readText(DRAFT_KEY, DEFAULT_DRAFT) }],
  );
  activeDraftId = $state(workspace?.active ?? "scratch");
  activeDraft = $derived(
    requiredValue(
      this.drafts.find((item) => item.id === this.activeDraftId),
      "selected entry",
    ),
  );
  draft = $derived(this.activeDraft.sql);
  history = $state<string[]>(readJson(HISTORY_KEY, parseHistory, []));
  saved = $state<SavedQuery[]>(readJson(SAVED_KEY, parseSaved, []));
  /** Saved query open in the editor (`null` = a loose draft). */
  currentId = $derived(this.activeDraft.queryId);

  current = $derived(this.saved.find((q) => q.id === this.currentId) ?? null);
  /** The editor text differs from what is saved. */
  dirty = $derived(
    this.current != null ? this.current.sql !== this.draft : this.draft.trim() !== "",
  );
  looseDrafts = $derived(
    this.drafts.filter(
      (item) => (item.queryId == null || item.queryId === "") && item.sql.trim() !== "",
    ),
  );
  /** Most recent first. */
  sorted = $derived([...this.saved].toSorted((a, b) => b.updatedAt - a.updatedAt));

  constructor() {
    // A missing saved copy must not make its persisted draft unreachable.
    for (const draft of this.drafts) {
      if (
        draft.queryId !== null &&
        draft.queryId !== "" &&
        this.saved.some((query) => query.id === draft.queryId) === false
      )
        draft.queryId = null;
    }
    // Another tab of the panel saved or renamed a query: take its list, or
    // the next write from this tab would put back the old one and lose it.
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (event) => this.syncStorage(event.key, event.newValue));
    }
  }

  setDraft(sql: string) {
    this.activeDraft.sql = sql;
    this.persistWorkspace();
  }

  /**
   * Forgets what this browser kept of the work: executed statements and open
   * drafts can hold passwords or keys, and outlive the session on a shared
   * machine. Queries saved on purpose stay.
   */
  forgetSession() {
    forgetSessionWork();
    this.#forgetWork();
  }

  /**
   * Follows another tab's change to the stored work (`key` null: storage
   * cleared). A sign-out there removes the workspace; keeping this tab's
   * copy would write it back on the next keystroke.
   */
  syncStorage(key: string | null, value: string | null) {
    if (key === SAVED_KEY) this.saved = readJson(SAVED_KEY, parseSaved, []);
    if (key === HISTORY_KEY) this.history = readJson(HISTORY_KEY, parseHistory, []);
    if ((key === WORKSPACE_KEY && value === null) || key === null) this.#forgetWork();
  }

  #forgetWork() {
    this.history = [];
    this.drafts = [{ id: "scratch", queryId: null, sql: DEFAULT_DRAFT }];
    this.activeDraftId = "scratch";
  }

  /** Opens a text in the editor; with `id`, starts editing that saved query. */
  open(sql: string, id: string | null = null) {
    const existing =
      id != null && id !== ""
        ? this.drafts.find((item) => item.queryId === id)
        : this.drafts.find(
            (item) => (item.queryId == null || item.queryId === "") && item.sql === sql,
          );
    const draft: SqlDraft = existing ?? { id: newId(), queryId: id, sql };
    if (existing == null) this.drafts.push(draft);
    this.activeDraftId = draft.id;
    this.persistWorkspace();
  }

  openDraft(id: string) {
    if (this.drafts.some((item) => item.id === id) === false) return;
    this.activeDraftId = id;
    this.persistWorkspace();
  }

  removeDraft(id: string) {
    this.drafts = this.drafts.filter((item) => item.id !== id);
    if (this.activeDraftId === id) {
      if (this.drafts.length === 0) {
        this.open("");
        return;
      }
      this.activeDraftId = requiredValue(this.drafts[0], "bounded operation item").id;
    }
    this.persistWorkspace();
  }

  openSaved(id: string) {
    const query = this.saved.find((q) => q.id === id);
    if (query != null) this.open(query.sql, query.id);
  }

  remember(sql: string) {
    this.history = [sql, ...this.history.filter((h) => h !== sql)].slice(0, HISTORY_LIMIT);
    write(HISTORY_KEY, JSON.stringify(this.history));
  }

  /** Updates the open query or creates a new one (`asNew`). */
  save(name: string, asNew = false): SavedQuery {
    const now = Date.now();
    const existing = asNew ? null : this.current;
    const query: SavedQuery =
      existing != null
        ? { ...existing, name, sql: this.draft, updatedAt: now }
        : { id: newId(), name, sql: this.draft, updatedAt: now };
    this.saved =
      existing != null
        ? this.saved.map((q) => (q.id === query.id ? query : q))
        : [...this.saved, query];
    const separateDraft = asNew && this.currentId !== null && this.currentId !== "";
    if (Boolean(separateDraft) === false) this.activeDraft.queryId = query.id;
    if (separateDraft) {
      const draft = { id: newId(), queryId: query.id, sql: query.sql };
      this.drafts.push(draft);
      this.activeDraftId = draft.id;
    }
    this.persist();
    this.persistWorkspace();
    return query;
  }

  rename(id: string, name: string) {
    this.saved = this.saved.map((q) => (q.id === id ? { ...q, name, updatedAt: Date.now() } : q));
    this.persist();
  }

  remove(id: string) {
    this.saved = this.saved.filter((q) => q.id !== id);
    // Preserve the editor contents even when the saved copy is deleted.
    for (const draft of this.drafts) if (draft.queryId === id) draft.queryId = null;
    this.persist();
    this.persistWorkspace();
  }

  private persistWorkspace() {
    write(WORKSPACE_KEY, JSON.stringify({ v: 1, active: this.activeDraftId, items: this.drafts }));
  }

  private persist() {
    write(SAVED_KEY, JSON.stringify({ v: 1, items: this.saved }));
  }
}

export const sqlStore = new SqlStore();
