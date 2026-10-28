// The tables home: which tables to show, in what order, which need attention,
// who can reach them and which were opened last. Pure rules, no rendering.

import type { Grants, OverviewTable, RlsState, TableSummary } from '$lib/contracts/types'
import { access, type Access } from '$lib/shared/schema/plain'

export type HomeFilter = 'all' | 'attention' | 'views'
export const HOME_FILTERS: readonly HomeFilter[] = ['all', 'attention', 'views']

export type HomeSortKey = 'name' | 'rows'
export interface HomeSort {
  readonly key: HomeSortKey
  readonly desc: boolean
}

/** Unprotected or blocked tables are the ones a person has to act on. */
export function needsAttention(state: RlsState): boolean {
  return state === 'danger' || state === 'warn'
}

export function isView(table: TableSummary): boolean {
  return table.kind !== 'table'
}

interface HomeQuery {
  readonly search: string
  readonly filter: HomeFilter
  readonly sort: HomeSort
}

/** Tables and views split in two groups, after search, filter and order. */
export function arrangeTables(
  tables: readonly TableSummary[],
  details: ReadonlyMap<string, OverviewTable>,
  query: HomeQuery,
): { tables: TableSummary[]; views: TableSummary[] } {
  const needle = query.search.trim().toLowerCase()
  const matching = tables.filter((table) => {
    if (needle !== '' && table.name.toLowerCase().includes(needle) === false) return false
    if (query.filter === 'attention') return needsAttention(table.rls.state)
    if (query.filter === 'views') return isView(table)
    return true
  })
  const ordered = [...matching].sort((a, b) => compare(a, b, details, query.sort))
  return {
    tables: ordered.filter((table) => isView(table) === false),
    views: ordered.filter(isView),
  }
}

function compare(a: TableSummary, b: TableSummary, details: ReadonlyMap<string, OverviewTable>, sort: HomeSort): number {
  const byName = a.name.localeCompare(b.name)
  if (sort.key === 'name') return sort.desc ? -byName : byName
  const rowsA = details.get(a.name)?.rows ?? null
  const rowsB = details.get(b.name)?.rows ?? null
  // Unknown counts (views, a missing overview) always go last, in name order.
  if (rowsA === null && rowsB === null) return byName
  if (rowsA === null) return 1
  if (rowsB === null) return -1
  if (rowsA === rowsB) return byName
  return sort.desc ? rowsB - rowsA : rowsA - rowsB
}

export interface AccessPart {
  readonly who: 'anon' | 'authenticated'
  readonly level: Access
  readonly verbs: ReturnType<typeof access>['verbs']
}

/**
 * Who reaches a table through the API, in at most two parts. Signed-in users
 * are only listed when their access differs from visitors'. Empty means only
 * the backend (service_role) reaches it.
 */
export function accessSummary(grants: Grants): AccessPart[] {
  const anon = access(grants.anon)
  const signedIn = access(grants.authenticated)
  const parts: AccessPart[] = []
  if (anon.level !== 'none') parts.push({ who: 'anon', ...anon })
  const sameAsAnon = anon.level === signedIn.level && anon.verbs.join() === signedIn.verbs.join()
  if (signedIn.level !== 'none' && sameAsAnon === false) parts.push({ who: 'authenticated', ...signedIn })
  return parts
}

export const RECENT_LIMIT = 3

/** The recent list with `name` first, without repeats, at most `RECENT_LIMIT` long. */
export function rememberRecent(recent: readonly string[], name: string): string[] {
  return [name, ...recent.filter((entry) => entry !== name)].slice(0, RECENT_LIMIT)
}

/** Stored recent names, or null when the stored value is not a list of names. */
export function parseRecent(data: unknown): string[] | null {
  if (Array.isArray(data) === false) return null
  const names = data.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  if (names.length !== data.length) return null
  return names.slice(0, RECENT_LIMIT)
}
