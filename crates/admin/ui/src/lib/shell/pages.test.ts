import { describe, expect, it, vi } from 'vitest'
import { loadPage, pageFor } from './pages'

describe('pageFor', () => {
  it('finds a page for every route the shell renders', () => {
    for (const path of ['/', '/updates', '/tables', '/tables/notes', '/tables/notes/structure', '/sql', '/migrations', '/users', '/sign-in', '/storage', '/storage/documents', '/policies', '/webhooks', '/webhooks/deliveries/42', '/projects', '/connect', '/guides', '/guides/quickstart']) {
      expect(pageFor(path), path).not.toBeNull()
    }
  })

  it('passes route parameters as props', () => {
    expect(pageFor('/tables')?.props).toEqual({ name: undefined, view: 'data' })
    expect(pageFor('/tables/notes')?.props).toEqual({ name: 'notes', view: 'data' })
    expect(pageFor('/tables/notes/structure')?.props).toEqual({ name: 'notes', view: 'structure' })
    expect(pageFor('/storage/documents')?.props).toEqual({ bucket: 'documents' })
    expect(pageFor('/webhooks/deliveries/42')?.props).toEqual({ id: '42' })
  })

  it('keeps one editor (same key and module) across a table\'s two views', () => {
    const data = pageFor('/tables/notes')
    const structure = pageFor('/tables/notes/structure')
    expect(structure?.key).toBe('/tables/notes')
    expect(data?.key).toBe('/tables/notes')
    expect(structure?.load).toBe(data?.load)
    expect(pageFor('/users')?.key).toBe('/users')
  })

  it('treats a trailing slash like the shell does', () => {
    expect(pageFor('')?.load).toBe(pageFor('/')?.load)
    expect(pageFor('/users/')?.load).toBe(pageFor('/users')?.load)
  })

  it('has no page for an unknown path', () => {
    expect(pageFor('/nope')).toBeNull()
    expect(pageFor('/storage/a/b')).toBeNull()
  })
})

describe('loadPage', () => {
  it('returns the same promise while a page is loading or loaded', async () => {
    const module = { default: (() => {}) as never }
    const load = vi.fn(async () => module)
    expect(loadPage(load)).toBe(loadPage(load))
    await loadPage(load)
    expect(load).toHaveBeenCalledOnce()
  })

  it('tries again after a failed download', async () => {
    const module = { default: (() => {}) as never }
    const load = vi.fn<() => Promise<typeof module>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(module)
    await expect(loadPage(load)).rejects.toThrow('offline')
    await expect(loadPage(load)).resolves.toBe(module)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
