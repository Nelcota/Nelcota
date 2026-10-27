import { describe, expect, it } from 'vitest'
import type { OverviewTable, RlsState, TableSummary } from '$lib/contracts/types'
import { accessSummary, arrangeTables, needsAttention, parseRecent, rememberRecent } from './home'

const rls = (state: RlsState) => ({ state, label: state, enabled: state === 'ok', forced: false, policies: 0 })
const table = (name: string, state: RlsState = 'ok', kind = 'table'): TableSummary => ({ name, kind, has_pk: true, rls: rls(state) })
const detail = (name: string, rows: number | null): OverviewTable => ({
  name, kind: 'table', comment: null, rows, rows_exact: true, rls: rls('ok'), grants: { anon: [], authenticated: [] },
})

describe('arrangeTables', () => {
  const tables = [table('profiles'), table('open_data', 'danger'), table('balances', 'view', 'view'), table('blocked', 'warn')]
  const details = new Map([['profiles', detail('profiles', 2)], ['open_data', detail('open_data', 50)], ['blocked', detail('blocked', null)]])
  const byName = { key: 'name', desc: false } as const

  it('splits views from tables and orders by name', () => {
    const result = arrangeTables(tables, details, { search: '', filter: 'all', sort: byName })
    expect(result.tables.map((entry) => entry.name)).toEqual(['blocked', 'open_data', 'profiles'])
    expect(result.views.map((entry) => entry.name)).toEqual(['balances'])
  })

  it('searches without case and ignores surrounding spaces', () => {
    const result = arrangeTables(tables, details, { search: '  OPEN ', filter: 'all', sort: byName })
    expect(result.tables.map((entry) => entry.name)).toEqual(['open_data'])
    expect(result.views).toEqual([])
  })

  it('keeps only unprotected and blocked tables for attention', () => {
    const result = arrangeTables(tables, details, { search: '', filter: 'attention', sort: byName })
    expect(result.tables.map((entry) => entry.name)).toEqual(['blocked', 'open_data'])
  })

  it('keeps only views for the views filter', () => {
    const result = arrangeTables(tables, details, { search: '', filter: 'views', sort: byName })
    expect(result.tables).toEqual([])
    expect(result.views.map((entry) => entry.name)).toEqual(['balances'])
  })

  it('orders by rows in both directions with unknown counts last', () => {
    const most = arrangeTables(tables, details, { search: '', filter: 'all', sort: { key: 'rows', desc: true } })
    expect(most.tables.map((entry) => entry.name)).toEqual(['open_data', 'profiles', 'blocked'])
    const fewest = arrangeTables(tables, details, { search: '', filter: 'all', sort: { key: 'rows', desc: false } })
    expect(fewest.tables.map((entry) => entry.name)).toEqual(['profiles', 'open_data', 'blocked'])
  })

  it('orders names in reverse', () => {
    const result = arrangeTables(tables, details, { search: '', filter: 'all', sort: { key: 'name', desc: true } })
    expect(result.tables.map((entry) => entry.name)).toEqual(['profiles', 'open_data', 'blocked'])
  })
})

describe('needsAttention', () => {
  it('flags only unprotected and blocked states', () => {
    expect(['ok', 'warn', 'danger', 'none', 'view'].filter((state) => needsAttention(state as RlsState))).toEqual(['warn', 'danger'])
  })
})

describe('accessSummary', () => {
  it('is empty when only the backend has access', () => {
    expect(accessSummary({ anon: [], authenticated: [] })).toEqual([])
  })

  it('lists signed-in users alone when visitors have no access', () => {
    expect(accessSummary({ anon: [], authenticated: ['SELECT'] })).toEqual([{ who: 'authenticated', level: 'read', verbs: ['read'] }])
  })

  it('omits signed-in users when they have the same access as visitors', () => {
    expect(accessSummary({ anon: ['SELECT'], authenticated: ['select'] })).toEqual([{ who: 'anon', level: 'read', verbs: ['read'] }])
  })

  it('lists both when signed-in users can do more', () => {
    const parts = accessSummary({ anon: ['SELECT'], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] })
    expect(parts.map((part) => [part.who, part.level])).toEqual([['anon', 'read'], ['authenticated', 'full']])
  })
})

describe('recent tables', () => {
  it('puts the opened table first without repeats and keeps three', () => {
    expect(rememberRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    expect(rememberRecent(['a', 'b', 'c'], 'd')).toEqual(['d', 'a', 'b'])
    expect(rememberRecent([], 'a')).toEqual(['a'])
  })

  it('accepts only a list of names from storage', () => {
    expect(parseRecent(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseRecent(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c'])
    expect(parseRecent('a')).toBeNull()
    expect(parseRecent(['a', 3])).toBeNull()
    expect(parseRecent(['a', '  '])).toBeNull()
    expect(parseRecent(null)).toBeNull()
  })
})
