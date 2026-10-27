import { afterEach, describe, expect, it, vi } from 'vitest'
import { rememberSignedIn, wasSignedIn } from './prefetch'

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

describe('signed-in hint', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is off for a browser that never signed in', () => {
    vi.stubGlobal('localStorage', storage())
    expect(wasSignedIn()).toBe(false)
  })

  it('follows the session: set once signed in, cleared on sign-out', () => {
    vi.stubGlobal('localStorage', storage())
    rememberSignedIn(true)
    expect(wasSignedIn()).toBe(true)
    rememberSignedIn(false)
    expect(wasSignedIn()).toBe(false)
  })

  it('is off, without throwing, when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied', 'SecurityError') },
      setItem: () => { throw new DOMException('denied', 'SecurityError') },
      removeItem: () => { throw new DOMException('denied', 'SecurityError') },
    })
    expect(() => rememberSignedIn(true)).not.toThrow()
    expect(() => rememberSignedIn(false)).not.toThrow()
    expect(wasSignedIn()).toBe(false)
  })
})
