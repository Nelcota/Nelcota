import { describe, expect, it, vi } from 'vitest'
import { runAs, runAsRequest, setRunAs } from './run-as.svelte'
import { SqlExecution, type SqlAdapter } from './execution.svelte'

describe('run as', () => {
  it('starts as the database owner and builds each request', () => {
    expect(runAs.mode).toBe('owner')
    expect(runAsRequest()).toEqual({ role: 'owner' })
    setRunAs('anon')
    expect(runAsRequest()).toEqual({ role: 'anon' })
    setRunAs('authenticated', { id: 'u-1', email: 'ana@example.com' })
    expect(runAsRequest()).toEqual({ role: 'authenticated', user_id: 'u-1' })
    // Leaving the signed-in mode forgets the user.
    setRunAs('owner')
    expect(runAs.user).toBeNull()
    expect(runAsRequest()).toEqual({ role: 'owner' })
  })

  it('never turns a signed-in run without a user into an owner run', () => {
    runAs.mode = 'authenticated'
    runAs.user = null
    expect(() => runAsRequest()).toThrow()
    setRunAs('owner')
  })

  it('travels with the run to the adapter', async () => {
    const adapter: SqlAdapter = {
      execute: vi.fn(async () => ({ results: [], results_truncated: false })),
      schema: vi.fn(),
    }
    await new SqlExecution(adapter).run('select 1', { role: 'anon' })
    expect(vi.mocked(adapter.execute).mock.calls[0][2]).toEqual({ role: 'anon' })
  })
})
