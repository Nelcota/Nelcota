import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, parseResponse } from './api'
import { errorMessage, i18n } from '$lib/i18n/index.svelte'
import { session } from '$lib/resources/session.svelte'
import { clearQuerySession, queryRead } from '$lib/resources/query-client'

function respond(body: string, status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
}

async function failure(): Promise<ApiError> {
  try {
    await api.get('/anything')
  } catch (e) {
    return e as ApiError
  }
  throw new Error('the request did not fail')
}

afterEach(() => { vi.unstubAllGlobals(); clearQuerySession() })

describe('mutation reconciliation', () => {
  it('discards superseded authentication while it is still waiting to send', async () => {
    let finish!: (response: Response) => void
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/logout')) return new Promise<Response>(resolve => { finish = resolve })
      return new Response(JSON.stringify({ email: 'new@example.com' }))
    })
    vi.stubGlobal('fetch', fetch)
    const old = api.post('/logout').catch(error => error)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const obsolete = api.post('/login', { email: 'obsolete@example.com' }).catch(error => error)
    const current = api.post('/login', { email: 'new@example.com' })
    finish(new Response(JSON.stringify({ ok: true })))
    await old
    expect(await obsolete).toMatchObject({ name: 'AbortError' })
    expect(await current).toEqual({ email: 'new@example.com' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toBe('/admin/api/login')
  })

  it.each(['resolve', 'reject'])('waits for an earlier logout before starting login when it will %s', async outcome => {
    let finish!: (response: Response) => void, reject!: (reason: unknown) => void
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/login')) return new Response(JSON.stringify({ email: 'new@example.com' }))
      return new Promise<Response>((yes, no) => { finish = yes; reject = no })
    })
    vi.stubGlobal('fetch', fetch)
    const old = api.post('/logout').catch(error => error)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    const current = api.post<{ email: string }>('/login')
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    try {
      // Set-Cookie is applied by the browser before the response promise resolves.
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      if (outcome === 'resolve') finish(new Response(JSON.stringify({ ok: true })))
      if (outcome === 'reject') reject(new Error('network failed'))
      await old
      await current
    }
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not deliver a previous session write result to a newly signed-in view', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/login')) return new Response(JSON.stringify({ email: 'new@example.com' }))
      return new Promise<Response>(resolve => { finish = resolve })
    }))
    const old = api.put('/anything', {}).catch(error => error)
    const me = await api.post<{ email: string }>('/login')
    session.email = me.email
    finish(new Response(JSON.stringify({ saved: true })))
    expect(await old).toMatchObject({ name: 'AbortError' })
    expect(session.email).toBe('new@example.com')
  })

  it('ignores an old session rejection after a new login succeeds', async () => {
    session.email = 'old@example.com'
    session.expired = false
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/login')) return new Response(JSON.stringify({ email: 'new@example.com' }))
      return new Promise<Response>(resolve => { finish = resolve })
    }))
    const old = api.put('/anything', {}).catch(error => error)
    const me = await api.post<{ email: string }>('/login')
    session.email = me.email
    finish(new Response(JSON.stringify({ error: 'expired' }), { status: 401 }))
    await old
    expect(session.email).toBe('new@example.com')
    expect(session.expired).toBe(false)
  })

  it('invalidates old reads even when a committed write has an invalid response contract', async () => {
    await queryRead('/rows', 'admin', async () => 'before mutation')
    await expect(parseResponse(new Response('{}'), '/tables', 'POST')).rejects.toMatchObject({ code: 'invalid_response' })
    expect(await queryRead('/rows', 'admin', async () => 'updated')).toBe('updated')
  })

  it('invalidates at the successful headers instead of waiting for the write body', async () => {
    await queryRead('/rows', 'admin', async () => 'before mutation')
    let finish!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ sql: [], applied: true, catalog_pending: false })))
          controller.close()
        }
      },
    })
    const write = parseResponse(new Response(body), '/tables', 'POST')
    try {
      expect(await queryRead('/rows', 'admin', async () => 'updated')).toBe('updated')
    } finally { finish(); await write }
  })
})

describe('JSON request values', () => {
  it.each([NaN, Infinity, -Infinity, new Number(NaN)])('refuses non-finite input %s instead of clearing a nullable setting', async value => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(api.put('/storage/buckets/documents', { file_size_limit: value })).rejects.toThrow()
    await expect(api.post('/storage/buckets', { nested: [value] })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('still sends an explicit null to clear a setting', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    await api.put('/anything', { file_size_limit: null })
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ body: '{"file_size_limit":null}' })
  })
})

describe('error responses', () => {
  it.each([undefined, '1', '1000000'])('cancels oversized proxy errors with length %s', async length => {
    const cancel = vi.fn()
    let chunks = 0
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      if (chunks++ === 10) { controller.close(); return }
      controller.enqueue(new Uint8Array(8192))
    })
    const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 })
    const headers = length ? { 'content-length': length } : undefined
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 502, headers })))
    const error = await failure()
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 502, code: 'server_unreachable' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(pull.mock.calls.length).toBe(length === '1000000' ? 0 : 9)
    expect(body.locked).toBe(false)
  })

  it('preserves a valid error at the exact byte boundary', async () => {
    const error = JSON.stringify({ error: 'ação', code: 'db_error' })
    respond(error + ' '.repeat(65536 - new TextEncoder().encode(error).length), 409)
    expect(await failure()).toMatchObject({ status: 409, code: 'db_error', message: 'ação' })
  })

  it('an oversized 401 still expires the local session', async () => {
    session.email = 'admin@example.com'
    session.expired = false
    // The query cache cancels callers on sign-out; inspect the parser's
    // HTTP failure directly while still exercising the session boundary.
    await expect(parseResponse(new Response(' '.repeat(65537), { status: 401 }), '/anything', 'GET'))
      .rejects.toMatchObject({ status: 401 })
    expect(session.email).toBeNull()
    expect(session.expired).toBe(true)
  })

  it('keeps the code and text of a panel error', async () => {
    respond(JSON.stringify({ error: 'bucket not found', code: 'bucket_not_found' }), 404)
    const error = await failure()
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('bucket_not_found')
    expect(error.message).toBe('bucket not found')
  })

  it('never shows a proxy HTML page; a gateway status reads as unreachable', async () => {
    respond('<html><body><h1>502 Bad Gateway</h1></body></html>', 502)
    const error = await failure()
    expect(error.status).toBe(502)
    expect(error.code).toBe('server_unreachable')
    i18n.locale = 'en'
    expect(errorMessage(error)).toContain('HTTP 502')
    expect(errorMessage(error)).not.toContain('<html>')
  })

  it('a 401 signs out and flags an expired session only when signed in', async () => {
    const unauthorized = JSON.stringify({ error: 'session expired', code: 'session_expired' })
    session.email = undefined
    session.expired = false
    respond(unauthorized, 401)
    await failure()
    expect(session.email).toBeNull()
    expect(session.expired).toBe(false)

    session.email = 'admin@example.com'
    respond(unauthorized, 401)
    await failure()
    expect(session.email).toBeNull()
    expect(session.expired).toBe(true)
  })

  it('other non-JSON or empty bodies read as an unexpected response', async () => {
    respond('Payload Too Large', 413)
    expect((await failure()).code).toBe('unexpected_response')
    respond('', 500)
    expect((await failure()).code).toBe('unexpected_response')
  })
})
