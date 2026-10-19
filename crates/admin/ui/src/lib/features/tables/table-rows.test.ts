import { describe, expect, it, vi } from 'vitest'
import type { TableData } from '$lib/contracts/types'
import { TableRows, type TableRowsAdapter } from './table-rows.svelte'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function page(name: string, ids = ['1', '2']): TableData {
  return {
    table: { name, kind: 'table', comment: null, primary_key: ['id'], editable: true, insertable: true,
      exposed_without_rls: false, columns: [], rls: { state: 'ok', label: '', enabled: true, forced: false, policies: 1 } },
    rows: ids.map(id => ({ id, value: `old-${id}` })), page: 0, size: 25, has_next: false, total: ids.length, total_exact: true,
  }
}
function fixture() {
  const adapter: TableRowsAdapter = {
    read: vi.fn(async (table: string) => page(table)),
    update: vi.fn(async () => ({ count: 1 })),
    remove: vi.fn(async () => ({ count: 1 })),
  }
  return { adapter, rows: new TableRows(adapter) }
}

describe('table row operations', () => {
  it('clear forgets rows and selection, so a read as someone else never shows stale ones', async () => {
    const { rows } = fixture()
    await rows.load('docs', new URLSearchParams())
    rows.selected = new Set([0])
    rows.clear()
    expect(rows.data).toBeNull()
    expect(rows.selected.size).toBe(0)
  })

  it('reconciles an edit by primary key after rows change position', async () => {
    const { rows, adapter } = fixture(), pending = deferred<{ count: number }>()
    adapter.update = vi.fn(() => pending.promise)
    await rows.load('docs', new URLSearchParams())
    const edit = rows.edit({ id: '1' }, 'value', null)
    rows.data!.rows.reverse()
    pending.resolve({ count: 1 })
    expect(await edit).toBe(1)
    expect(rows.data!.rows).toEqual([{ id: '2', value: 'old-2' }, { id: '1', value: null }])
    expect(adapter.update).toHaveBeenCalledWith('docs', { id: '1' }, { value: null })
  })

  it('does not mutate or reload another table when a write finishes after navigation', async () => {
    const { rows, adapter } = fixture(), pending = deferred<{ count: number }>()
    adapter.update = vi.fn(() => pending.promise)
    await rows.load('a', new URLSearchParams())
    const edit = rows.edit({ id: '1' }, 'value', 'changed')
    await rows.load('b', new URLSearchParams())
    pending.resolve({ count: 1 })
    await edit
    expect(rows.data!.table.name).toBe('b')
    expect(rows.data!.rows[0].value).toBe('old-1')
    expect(adapter.read).toHaveBeenCalledTimes(2)
    expect(rows.saving).toBe(false)
  })

  it('refreshes the current page after a write on the same table completes', async () => {
    const { rows, adapter } = fixture(), pending = deferred<{ count: number }>()
    adapter.update = vi.fn(() => pending.promise)
    await rows.load('docs', new URLSearchParams('page=0'))
    const edit = rows.edit({ id: '1' }, 'value', 'changed')
    await rows.load('docs', new URLSearchParams('page=1'))
    pending.resolve({ count: 1 })
    await edit
    expect(adapter.read).toHaveBeenCalledTimes(3)
    expect(vi.mocked(adapter.read).mock.calls[2][1].get('page')).toBe('1')
  })

  it('captures selected primary keys before navigation during deletion', async () => {
    const { rows, adapter } = fixture(), pending = deferred<{ count: number }>()
    adapter.remove = vi.fn(() => pending.promise)
    await rows.load('a', new URLSearchParams())
    rows.selected = new Set([1])
    const deletion = rows.deleteSelected()
    await rows.load('b', new URLSearchParams())
    pending.resolve({ count: 1 })
    expect(await deletion).toBe(1)
    expect(adapter.remove).toHaveBeenCalledWith('a', [{ id: '2' }])
    expect(rows.data!.table.name).toBe('b')
    expect(rows.selected.size).toBe(0)
    expect(adapter.read).toHaveBeenCalledTimes(2)
  })

  it('blocks overlapping writes and releases saving state after failure', async () => {
    const { rows, adapter } = fixture(), pending = deferred<{ count: number }>()
    adapter.update = vi.fn(() => pending.promise)
    await rows.load('docs', new URLSearchParams())
    const edit = rows.edit({ id: '1' }, 'value', 'changed')
    expect(await rows.edit({ id: '2' }, 'value', 'other')).toBeUndefined()
    const failure = expect(edit).rejects.toThrow('offline')
    pending.reject(new Error('offline'))
    await failure
    expect(rows.saving).toBe(false)
    expect(rows.data!.rows[0].value).toBe('old-1')
    expect(adapter.update).toHaveBeenCalledTimes(1)
  })

  it('blocks edits while loading and ignores responses after cancellation', async () => {
    const { rows, adapter } = fixture(), pending = deferred<TableData>()
    await rows.load('docs', new URLSearchParams())
    adapter.read = vi.fn(() => pending.promise)
    const loading = rows.load('docs', new URLSearchParams('page=1'))
    expect(await rows.edit({ id: '1' }, 'value', 'changed')).toBeUndefined()
    rows.cancel()
    pending.resolve(page('docs', ['3']))
    await loading
    expect(rows.data!.rows[0].id).toBe('1')
    expect(adapter.update).not.toHaveBeenCalled()
  })
})
