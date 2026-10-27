import { afterEach, describe, expect, it, vi } from 'vitest'
import { deadlineSignal, manualDeadlineSignal } from './deadline'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('manual deadline signal', () => {
  it('aborts with a TimeoutError when the deadline passes', () => {
    vi.useFakeTimers()
    const signal = manualDeadlineSignal(undefined, 20000)
    vi.advanceTimersByTime(19999)
    expect(signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' })
  })

  it('follows the caller and keeps its reason', () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const signal = manualDeadlineSignal(caller.signal, 20000)
    caller.abort()
    expect(signal.reason).toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is already aborted when the caller already was', () => {
    const caller = new AbortController()
    caller.abort(new Error('gone'))
    expect(manualDeadlineSignal(caller.signal, 20000).reason).toEqual(new Error('gone'))
  })
})

describe('deadline signal', () => {
  it('uses the native helpers when the browser has them', () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const any = vi.spyOn(AbortSignal, 'any')
    const caller = new AbortController()
    deadlineSignal(caller.signal, 20000)
    expect(timeout).toHaveBeenCalledWith(20000)
    expect(any).toHaveBeenCalledOnce()
  })

  it('falls back when AbortSignal.any is missing', () => {
    vi.useFakeTimers()
    const original = AbortSignal.any
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true })
    try {
      const signal = deadlineSignal(new AbortController().signal, 1000)
      vi.advanceTimersByTime(1000)
      expect(signal.reason).toMatchObject({ name: 'TimeoutError' })
    } finally {
      Object.defineProperty(AbortSignal, 'any', { value: original, configurable: true, writable: true })
    }
  })
})
