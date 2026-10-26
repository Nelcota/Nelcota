// SQL editor state: draft, history and saved queries. Lives outside the
// component so the command palette can open a query in the editor.
// Persisted in the browser (per project, since each panel has its own origin).

import { newId } from '$lib/browser/id'
import { readJson, readText, write } from '$lib/browser/local-storage'

const DRAFT_KEY = 'nelcota:sql-draft'
const HISTORY_KEY = 'nelcota:sql-history'
const SAVED_KEY = 'nelcota:sql-saved'
const WORKSPACE_KEY = 'nelcota:sql-workspace'
const HISTORY_LIMIT = 20

export interface SavedQuery {
  id: string
  name: string
  sql: string
  updatedAt: number
}

export interface SqlDraft {
  id: string
  queryId: string | null
  sql: string
}

interface Workspace { v: 1; active: string; items: SqlDraft[] }

function parseWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== 'object') return null
  const workspace = value as Workspace
  if (workspace.v !== 1 || typeof workspace.active !== 'string' || !Array.isArray(workspace.items)) return null
  const items = workspace.items.filter((item) => item && typeof item.id === 'string' && typeof item.sql === 'string' && (item.queryId === null || typeof item.queryId === 'string'))
  return items.some((item) => item.id === workspace.active) ? { v: 1, active: workspace.active, items } : null
}

const workspace = readJson<Workspace | null>(WORKSPACE_KEY, parseWorkspace, null)

const isSaved = (item: unknown): item is SavedQuery =>
  typeof item === 'object' &&
  item !== null &&
  typeof (item as SavedQuery).id === 'string' &&
  typeof (item as SavedQuery).name === 'string' &&
  typeof (item as SavedQuery).sql === 'string' &&
  typeof (item as SavedQuery).updatedAt === 'number'

// Versioned format: `{ v: 1, items }`, so it can be migrated later.
const parseSaved = (data: unknown): SavedQuery[] | null =>
  typeof data === 'object' && data !== null && (data as { v?: unknown }).v === 1
    ? ((data as { items?: unknown }).items as unknown[] | undefined)?.filter(isSaved) ?? []
    : null

const parseHistory = (data: unknown): string[] | null =>
  Array.isArray(data) ? data.filter((h): h is string => typeof h === 'string') : null

class SqlStore {
  drafts = $state<SqlDraft[]>(workspace?.items ?? [{ id: 'scratch', queryId: null, sql: readText(DRAFT_KEY, 'select now();') }])
  activeDraftId = $state(workspace?.active ?? 'scratch')
  activeDraft = $derived(this.drafts.find((item) => item.id === this.activeDraftId)!)
  draft = $derived(this.activeDraft.sql)
  history = $state<string[]>(readJson(HISTORY_KEY, parseHistory, []))
  saved = $state<SavedQuery[]>(readJson(SAVED_KEY, parseSaved, []))
  /** Saved query open in the editor (`null` = a loose draft). */
  currentId = $derived(this.activeDraft.queryId)

  current = $derived(this.saved.find((q) => q.id === this.currentId) ?? null)
  /** The editor text differs from what is saved. */
  dirty = $derived(this.current ? this.current.sql !== this.draft : this.draft.trim() !== '')
  looseDrafts = $derived(this.drafts.filter((item) => !item.queryId && item.sql.trim() !== ''))
  /** Most recent first. */
  sorted = $derived([...this.saved].sort((a, b) => b.updatedAt - a.updatedAt))

  constructor() {
    // A missing saved copy must not make its persisted draft unreachable.
    for (const draft of this.drafts) {
      if (draft.queryId && !this.saved.some((query) => query.id === draft.queryId)) draft.queryId = null
    }
    // Another tab of the panel saved or renamed a query: take its list, or
    // the next write from this tab would put back the old one and lose it.
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key === SAVED_KEY) this.saved = readJson(SAVED_KEY, parseSaved, [])
        if (event.key === HISTORY_KEY) this.history = readJson(HISTORY_KEY, parseHistory, [])
      })
    }
  }

  setDraft(sql: string) {
    this.activeDraft.sql = sql
    write(DRAFT_KEY, sql)
    this.persistWorkspace()
  }

  /** Opens a text in the editor; with `id`, starts editing that saved query. */
  open(sql: string, id: string | null = null) {
    const existing = id ? this.drafts.find((item) => item.queryId === id) : this.drafts.find((item) => !item.queryId && item.sql === sql)
    const draft: SqlDraft = existing ?? { id: newId(), queryId: id, sql }
    if (!existing) this.drafts.push(draft)
    this.activeDraftId = draft.id
    this.persistWorkspace()
  }

  openDraft(id: string) {
    if (!this.drafts.some((item) => item.id === id)) return
    this.activeDraftId = id
    this.persistWorkspace()
  }

  removeDraft(id: string) {
    this.drafts = this.drafts.filter((item) => item.id !== id)
    if (this.activeDraftId === id) {
      if (!this.drafts.length) { this.open(''); return }
      this.activeDraftId = this.drafts[0].id
    }
    this.persistWorkspace()
  }

  openSaved(id: string) {
    const query = this.saved.find((q) => q.id === id)
    if (query) this.open(query.sql, query.id)
  }

  remember(sql: string) {
    this.history = [sql, ...this.history.filter((h) => h !== sql)].slice(0, HISTORY_LIMIT)
    write(HISTORY_KEY, JSON.stringify(this.history))
  }

  /** Updates the open query or creates a new one (`asNew`). */
  save(name: string, asNew = false): SavedQuery {
    const now = Date.now()
    const existing = asNew ? null : this.current
    const query: SavedQuery = existing
      ? { ...existing, name, sql: this.draft, updatedAt: now }
      : { id: newId(), name, sql: this.draft, updatedAt: now }
    this.saved = existing ? this.saved.map((q) => (q.id === query.id ? query : q)) : [...this.saved, query]
    const separateDraft = asNew && this.currentId
    if (!separateDraft) this.activeDraft.queryId = query.id
    if (separateDraft) {
      const draft = { id: newId(), queryId: query.id, sql: query.sql }
      this.drafts.push(draft)
      this.activeDraftId = draft.id
    }
    this.persist()
    this.persistWorkspace()
    return query
  }

  rename(id: string, name: string) {
    this.saved = this.saved.map((q) => (q.id === id ? { ...q, name, updatedAt: Date.now() } : q))
    this.persist()
  }

  remove(id: string) {
    this.saved = this.saved.filter((q) => q.id !== id)
    // Preserve the editor contents even when the saved copy is deleted.
    for (const draft of this.drafts) if (draft.queryId === id) draft.queryId = null
    this.persist()
    this.persistWorkspace()
  }

  private persistWorkspace() {
    write(WORKSPACE_KEY, JSON.stringify({ v: 1, active: this.activeDraftId, items: this.drafts }))
  }

  private persist() {
    write(SAVED_KEY, JSON.stringify({ v: 1, items: this.saved }))
  }
}

export const sqlStore = new SqlStore()
