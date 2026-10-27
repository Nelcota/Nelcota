// Panel API client (/admin/api). The session lives in an HttpOnly cookie.
import { session } from '$lib/resources/session.svelte'
import { responseContract } from '$lib/contracts/responses'
import { t } from '$lib/i18n/index.svelte'
import { clearQuerySession, invalidateReads, queryRead, querySession } from '$lib/resources/query-client'
import { readBody } from './read-body'
import { ApiError, httpError } from './api-error'
export { ApiError, httpError } from './api-error'

let authentication = Promise.resolve()
const REQUEST_TIMEOUT_MS = 60_000

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const encoded = body === undefined ? undefined : JSON.stringify(body, (_key, original: unknown) => {
    const value = original instanceof Number ? original.valueOf() : original
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(t('common.invalidNumber'))
    return value
  })
  await loadContractFirst(method, path)
  const changesSession = ['/login', '/logout', '/sso'].includes(path)
  if (changesSession) clearQuerySession()
  const started = querySession()
  const send = async () => {
    requireSession(started)
    const controller = new AbortController()
    const deadline = new DOMException('Request deadline exceeded', 'TimeoutError')
    const abort = () => controller.abort(signal?.reason)
    const timer = setTimeout(() => controller.abort(deadline), REQUEST_TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) abort()
      controller.signal.throwIfAborted()
      const res = await fetch(`/admin/api${path}`, {
        method,
        signal: controller.signal,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: encoded,
      })
      const result = await parseResponse<T>(res, path, method, started, controller.signal)
      requireSession(started)
      return result
    } catch (error) {
      if (controller.signal.reason === deadline) {
        const reading = method === 'GET' || method === 'HEAD'
        // A missing response cannot prove a write was rolled back.
        if (!reading && started === querySession()) invalidateReads()
        const code = reading ? 'request_timeout' : 'write_timeout'
        throw new ApiError(t(`errors.${code}`), 504, code)
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  if (!changesSession) return send()
  // Epoch checks cannot undo Set-Cookie. Finish earlier authentication
  // responses before sending another request that replaces the same cookie.
  const pending = authentication.then(send)
  authentication = pending.then(() => {}, () => {})
  return pending
}

/**
 * Downloads the response's validator before the request is sent: a failed
 * download then fails the request before any side effect, rather than turning
 * a committed write (a secret shown once) into an error after the fact.
 * parseResponse's own lookup then resolves from the loaded module.
 */
async function loadContractFirst(method: string, path: string) {
  await responseContract(method, path)
}

/** Sends a file as the raw request body (storage uploads). */
export async function uploadFile<T>(path: string, file: File, onprogress?: (loaded: number, total: number) => void): Promise<T> {
  const started = querySession()
  const [{ upload }] = await Promise.all([import('./upload'), loadContractFirst('POST', path)])
  requireSession(started)
  // request() re-checks the session after parseResponse; uploads have no such
  // wrapper, so a response finished under another session is dropped here.
  const parse = async (response: Response) => {
    const result = await parseResponse<T>(response, path, 'POST', started)
    requireSession(started)
    return result
  }
  try { return await upload(path, file, parse, onprogress) }
  catch (error) {
    // A response aborted at the XHR budget never reaches parseResponse.
    if (error instanceof ApiError) expireSession(error.status, path, started)
    throw error
  }
}

export function expireSession(status: number, path = '', started = querySession()) {
  if (started !== querySession() || status !== 401 || path === '/login') return
  clearQuerySession()
  if (session.email) session.expired = true
  session.email = null
}

function requireSession(started: number) {
  if (started !== querySession()) throw new DOMException('Session changed', 'AbortError')
}

export async function parseResponse<T>(res: Response, path: string, method: string, started = querySession(), signal?: AbortSignal): Promise<T> {
  if (started !== querySession()) {
    void res.body?.cancel().catch(() => {})
    requireSession(started)
  }
  // Successful headers can follow a committed write even when decoding its
  // body fails. Refresh reads before parsing or validating that response.
  if (started === querySession() && res.ok && method !== 'GET' && method !== 'HEAD') invalidateReads()
  // Error pages are metadata; a proxy cannot force the panel to buffer its body.
  // Only errors have a byte cap; both body paths honor the request deadline.
  const body = await readBody(res, res.ok ? Number.MAX_SAFE_INTEGER : 64 * 1024, signal)
  const text = await body?.text() ?? ''
  signal?.throwIfAborted()
  requireSession(started)
  let data: unknown = null
  let json = true
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    json = false
    data = { error: text }
  }
  if (!res.ok) {
    expireSession(res.status, path, started)
    // Not our JSON error (e.g. a reverse proxy's HTML 502 page): never show
    // the raw body, say what happened in the user's language instead.
    if (!json) throw httpError(res.status)
    const body = data as { error?: string; code?: string; params?: Record<string, string | number> } | null
    if (!body?.error && !body?.code) throw httpError(res.status)
    throw new ApiError(body?.error ?? `HTTP ${res.status}`, res.status, body?.code, body?.params)
  }
  // A 200 that isn't JSON is someone else's page (an auth proxy's sign-in
  // form after a redirect), not this API answering.
  if (!json) throw new ApiError(t('common.invalidResponse'), 502, 'invalid_response')
  const validate = await responseContract(method, path)
  if (validate && !validate(data)) throw new ApiError(t('common.invalidResponse'), 502, 'invalid_response')
  return data as T
}

export const api = {
  get: <T>(path: string, options: { signal?: AbortSignal; freshForMs?: number } = {}) =>
    path === '/session' ? request<T>('GET', path, undefined, options.signal)
      : queryRead(path, session.email, signal => request<T>('GET', path, undefined, signal), options.signal, options.freshForMs ?? 0),
  post: <T>(path: string, body: unknown = {}, options: { signal?: AbortSignal } = {}) =>
    request<T>('POST', path, body, options.signal),
  patch: <T>(path: string, body: unknown, options: { signal?: AbortSignal } = {}) =>
    request<T>('PATCH', path, body, options.signal),
  put: <T>(path: string, body: unknown, options: { signal?: AbortSignal } = {}) =>
    request<T>('PUT', path, body, options.signal),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
}

export const enc = encodeURIComponent

/** Request cancelled by a newer one (not an error for the user). */
export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
