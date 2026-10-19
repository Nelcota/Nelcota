// Panel API client (/admin/api). The session lives in an HttpOnly cookie.
import { session } from '$lib/resources/session.svelte'
import { responseContract } from '$lib/contracts/responses'
import { t } from '$lib/i18n/index.svelte'
import { clearQuerySession, invalidateReads, queryRead, querySession } from '$lib/resources/query-client'
import { readBody } from './read-body'
import { ApiError, httpError } from './api-error'
export { ApiError, httpError } from './api-error'

let authentication = Promise.resolve()

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const encoded = body === undefined ? undefined : JSON.stringify(body, (_key, original: unknown) => {
    const value = original instanceof Number ? original.valueOf() : original
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(t('common.invalidNumber'))
    return value
  })
  const changesSession = ['/login', '/logout', '/sso'].includes(path)
  if (changesSession) clearQuerySession()
  const started = querySession()
  const send = async () => {
    requireSession(started)
    const res = await fetch(`/admin/api${path}`, {
      method,
      signal,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: encoded,
    })
    const result = await parseResponse<T>(res, path, method, started)
    requireSession(started)
    return result
  }
  if (!changesSession) return send()
  // Epoch checks cannot undo Set-Cookie. Finish earlier authentication
  // responses before sending another request that replaces the same cookie.
  const pending = authentication.then(send)
  authentication = pending.then(() => {}, () => {})
  return pending
}

/** Sends a file as the raw request body (storage uploads). */
export async function uploadFile<T>(path: string, file: File, onprogress?: (loaded: number, total: number) => void): Promise<T> {
  const started = querySession()
  const { upload } = await import('./upload')
  requireSession(started)
  try { return await upload(path, file, response => parseResponse<T>(response, path, 'POST', started), onprogress) }
  catch (error) {
    // A response aborted at the XHR budget never reaches parseResponse.
    if (error instanceof ApiError) expireSession(error.status, path, started)
    throw error
  }
}

function expireSession(status: number, path: string, started: number) {
  if (started !== querySession() || status !== 401 || path === '/login') return
  clearQuerySession()
  if (session.email) session.expired = true
  session.email = null
}

function requireSession(started: number) {
  if (started !== querySession()) throw new DOMException('Session changed', 'AbortError')
}

export async function parseResponse<T>(res: Response, path: string, method: string, started = querySession()): Promise<T> {
  if (started !== querySession()) {
    void res.body?.cancel().catch(() => {})
    requireSession(started)
  }
  // Successful headers can follow a committed write even when decoding its
  // body fails. Refresh reads before parsing or validating that response.
  if (started === querySession() && res.ok && method !== 'GET' && method !== 'HEAD') invalidateReads()
  // Error pages are metadata; a proxy cannot force the panel to buffer its body.
  const body = res.ok ? null : await readBody(res, 64 * 1024)
  const text = res.ok ? await res.text() : (await body?.text() ?? '')
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
  const validate = responseContract(method, path)
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
