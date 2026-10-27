import { describe, expect, it, vi } from 'vitest'
import { planStartup, retry } from './startup'

describe('planStartup', () => {
  it('does nothing for the updates controller', () => {
    expect(planStartup({ controller: true, handoffToken: null, signedInBefore: true })).toEqual({ checkSession: false, prefetchPanel: false })
  })

  it('checks the session right away unless a sign-on token is being traded', () => {
    expect(planStartup({ controller: false, handoffToken: null, signedInBefore: false }).checkSession).toBe(true)
    expect(planStartup({ controller: false, handoffToken: 'token', signedInBefore: false }).checkSession).toBe(false)
  })

  it('prefetches the panel only for a browser that was signed in', () => {
    expect(planStartup({ controller: false, handoffToken: null, signedInBefore: true }).prefetchPanel).toBe(true)
    expect(planStartup({ controller: false, handoffToken: null, signedInBefore: false }).prefetchPanel).toBe(false)
    expect(planStartup({ controller: false, handoffToken: 'token', signedInBefore: true }).prefetchPanel).toBe(true)
  })
})

describe('retry', () => {
  const noWait = vi.fn(async () => {})

  it('returns the first success, waiting the given delays in between', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attempt = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce('loaded')
    noWait.mockClear()
    await expect(retry(attempt, [300, 1000], noWait)).resolves.toBe('loaded')
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(noWait.mock.calls).toEqual([[300], [1000]])
  })

  it('does not wait when the first attempt succeeds', async () => {
    noWait.mockClear()
    await expect(retry(async () => 1, [300, 1000], noWait)).resolves.toBe(1)
    expect(noWait).not.toHaveBeenCalled()
  })

  it('rejects with the last error once every attempt failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let count = 0
    const attempt = async () => { count++; throw new Error(`attempt ${count}`) }
    await expect(retry(attempt, [300, 1000], noWait)).rejects.toThrow('attempt 3')
  })
})
