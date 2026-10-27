import { describe, expect, it, vi } from 'vitest'
import type { SqlResponse } from '$lib/contracts/types'
import { changesSchema, SqlExecution, type SqlAdapter } from './execution.svelte'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const result: SqlResponse = { results: [], results_truncated: false }
function fixture() {
  const adapter: SqlAdapter = {
    execute: vi.fn(async () => result),
    schema: vi.fn(async () => ({ schema: 'public', tables: { docs: ['id'] } })),
  }
  let clock = 10
  return { adapter, execution: new SqlExecution(adapter, () => clock), tick: (now: number) => { clock = now } }
}

describe('SQL execution lifetime', () => {
  it('keeps the response as the same plain object instead of a deep proxy', async () => {
    const { execution } = fixture()
    expect(await execution.run('select 1')).toBe(true)
    expect(execution.response).toBe(result)
  })
  it('captures SQL, refuses empty or overlapping runs and records duration', async () => {
    const { execution, adapter, tick } = fixture(), pending = deferred<SqlResponse>()
    adapter.execute = vi.fn(() => pending.promise)
    expect(await execution.run('  ')).toBe(false)
    const run = execution.run('select 1')
    expect(await execution.run('select 2')).toBe(false)
    expect(adapter.execute).toHaveBeenCalledTimes(1)
    expect(vi.mocked(adapter.execute).mock.calls[0][0]).toBe('select 1')
    tick(35)
    pending.resolve(result)
    expect(await run).toBe(true)
    expect(execution.elapsed).toBe(25)
    expect(execution.running).toBe(false)
    expect(execution.response).toEqual(result)
  })

  it('ignores a cancelled result even when the adapter ignores its signal', async () => {
    const { execution, adapter } = fixture(), old = deferred<SqlResponse>()
    adapter.execute = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(result)
    const run = execution.run('select old')
    const signal = vi.mocked(adapter.execute).mock.calls[0][1]
    execution.cancel()
    expect(signal.aborted).toBe(true)
    expect(await execution.run('select new')).toBe(true)
    old.resolve({ error: { message: 'stale', code: null, detail: null, hint: null, position: null } })
    expect(await run).toBe(false)
    expect(execution.response).toEqual(result)
    expect(execution.error).toBeNull()
    expect(execution.running).toBe(false)
  })

  it('releases execution after a transport failure and allows retry', async () => {
    const { execution, adapter } = fixture()
    adapter.execute = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(result)
    expect(await execution.run('select 1')).toBe(false)
    expect(execution.error).toEqual(new Error('offline'))
    expect(execution.running).toBe(false)
    expect(await execution.run('select 1')).toBe(true)
    expect(execution.error).toBeNull()
  })

  it('stops a running query and keeps schema loading', async () => {
    const { execution, adapter } = fixture(), pending = deferred<SqlResponse>()
    adapter.execute = vi.fn(() => pending.promise)
    const loading = execution.loadSchema()
    const run = execution.run('select pg_sleep(60)')
    const signal = vi.mocked(adapter.execute).mock.calls[0][1]
    execution.stop()
    expect(signal.aborted).toBe(true)
    expect(execution.running).toBe(false)
    pending.reject(new DOMException('Aborted', 'AbortError'))
    expect(await run).toBe(false)
    expect(execution.error).toBeNull()
    expect(await loading).toBe(true)
    expect(execution.schema.data?.tables).toEqual({ docs: ['id'] })
  })

  it('detects SQL that changes the schema', () => {
    expect(changesSchema('create table notes (id int)')).toBe(true)
    expect(changesSchema('ALTER TABLE notes ADD x int')).toBe(true)
    expect(changesSchema('select 1;\ndrop view v')).toBe(true)
    expect(changesSchema('select created_at from notes')).toBe(false)
    expect(changesSchema('update notes set dropped = true')).toBe(false)
  })

  it('cancels schema loading without preventing SQL execution', async () => {
    const { execution, adapter } = fixture(), schema = deferred<{ schema: string; tables: Record<string, string[]> }>()
    adapter.schema = vi.fn(() => schema.promise)
    const loading = execution.loadSchema()
    execution.cancel()
    schema.resolve({ schema: 'stale', tables: {} })
    expect(await loading).toBe(false)
    expect(execution.schema.data).toBeNull()
    expect(await execution.run('select 1')).toBe(true)
  })
})
