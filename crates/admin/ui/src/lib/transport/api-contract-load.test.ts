import { afterEach, describe, expect, it, vi } from 'vitest'

// The response validators are a lazy chunk. When it cannot be downloaded, a
// request must fail before it is sent: after a committed write (a webhook
// secret shown once) the failure would hide a change that did happen.
describe('response validators that fail to load', () => {
  afterEach(() => {
    vi.doUnmock('$lib/generated/validators.js')
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function apiWithoutValidators() {
    vi.resetModules()
    vi.doMock('$lib/generated/validators.js', () => {
      throw new TypeError('Failed to fetch dynamically imported module')
    })
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetch)
    const { api } = await import('./api')
    return { api, fetch }
  }

  it.each([
    ['POST', '/webhooks'],
    ['POST', '/webhooks/endpoint/rotate'],
    ['PATCH', '/tables/notes'],
    ['DELETE', '/webhooks/deliveries'],
  ] as const)('never sends %s %s', async (method, path) => {
    const { api, fetch } = await apiWithoutValidators()
    const senders = { POST: () => api.post(path, {}), PATCH: () => api.patch(path, {}), DELETE: () => api.delete(path) }
    await expect(senders[method]()).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('still sends requests that have no contract', async () => {
    const { api, fetch } = await apiWithoutValidators()
    await api.post('/logout')
    expect(fetch).toHaveBeenCalledOnce()
  })
})
