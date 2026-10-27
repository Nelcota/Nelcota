import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControllerError, request, controllerOrigin, pollDelay, sessionExpired, REQUEST_TIMEOUT_MS, parseJob, parsePlan, parseStatus, mergeStatus, type Job, type Status } from './controller'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const job: Job = { id: 'a'.repeat(64), project: 'shop', current: '0.4.0', target: '0.5.0', phase: 'validating', sequence: 6, updated_at: 123, committed: false, error: null }
const status: Status = { email: 'operator@example.test', projects: [{ name: 'shop', version: '0.4.0', update_available: true }], jobs: [job], release: { version: '0.5.0' }, enabled: true, checking: false, check_error: null }
describe('update capability responses', () => {
  it.each([null, 'false', 0, {}])('rejects a non-boolean host_busy (%j)', host_busy => {
    expect(() => parseStatus({ ...status, host_busy })).toThrow(ControllerError)
  })
  it('accepts absent and boolean host_busy states', () => {
    expect(parseStatus(status).host_busy).toBeUndefined()
    for (const host_busy of [true, false]) expect(parseStatus({ ...status, host_busy }).host_busy).toBe(host_busy)
  })
  it('rejects nullable, nonfinite, unsafe and unknown states', () => {
    for (const invalid of [null, {}, { ...job, phase: 'almost_done' }, { ...job, sequence: NaN }, { ...job, sequence: Infinity }, { ...job, sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...job, id: '../state' }, { ...job, committed: 'false' }]) expect(() => parseJob(invalid)).toThrow()
    expect(() => parseStatus({ ...status, jobs: [null] })).toThrow()
    expect(() => parsePlan({ id: job.id, digest: job.id, project: 'shop', current: '0.4.0', target: '0.5.0', expires_at: Infinity, blockers: [] })).toThrow()
  })
  it('does not regress progress when a stale response arrives after reconnect', () => {
    const next = mergeStatus(status, { ...status, jobs: [{ ...job, sequence: 3, phase: 'capturing' }] })
    expect(next.jobs[0].phase).toBe('validating')
    expect(next.jobs[0].sequence).toBe(6)
    expect(mergeStatus(next, { ...status, jobs: [{ ...job, sequence: 8, phase: 'succeeded', committed: true }] }).jobs[0].phase).toBe('succeeded')
  })
  it('retains an accepted active job if a poll started before acceptance omits it', () => {
    expect(mergeStatus(status, { ...status, jobs: [] }).jobs[0]).toEqual(job)
    expect(mergeStatus(status, { ...status, email: 'another@example.test', jobs: [] }).jobs).toEqual([])
  })
  it('only exposes canonical HTTPS controller origins', () => {
    for (const value of [null, 'javascript:alert(1)', 'http://host.test', 'https://user:password@host.test', 'https://host.test/path', 'https://host.test?token=x']) expect(controllerOrigin(value)).toBeNull()
    expect(controllerOrigin('https://updates.example.test')).toBe('https://updates.example.test')
  })
  it('rejects an oversized successful controller response without buffering it', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': '1048577' } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(request()).rejects.toMatchObject({ status: 502, code: 'invalid_response' })
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('preserves an unauthorized status when the proxy sends HTML instead of JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Unauthorized</html>', { status: 401 })))
    await expect(request()).rejects.toMatchObject({ status: 401, code: 'operation_blocked' })
    await expect(request()).rejects.toBeInstanceOf(ControllerError)
  })
  it('enforces the controller byte budget when content length is absent', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1048577)) }, cancel }, { highWaterMark: 0 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    await expect(request()).rejects.toMatchObject({ status: 502, code: 'invalid_response' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })
  it('cancels a pending controller body without awaiting an unsettled source cleanup', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    const abort = new AbortController()
    const pending = request(undefined, abort.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(body.locked).toBe(true))
    abort.abort()
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })
  it('gives up after the request timeout even when the caller never aborts', async () => {
    const timeout = new AbortController()
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    let seen: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      seen = init.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    }))
    const caller = new AbortController()
    const pending = request({ action: 'host_status' }, caller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(timer).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS)
    expect(seen?.aborted).toBe(false)
    timeout.abort(new DOMException('timed out', 'TimeoutError'))
    await rejected
    expect(caller.signal.aborted).toBe(false)
  })
  it('still lets the caller cancel before the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))))
    const caller = new AbortController()
    const pending = request(undefined, caller.signal)
    caller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('recognizes only an unauthorized controller error as an expired session', () => {
    expect(sessionExpired(new ControllerError(401, 'session_expired'))).toBe(true)
    expect(sessionExpired(new ControllerError(403, 'operation_blocked'))).toBe(false)
    expect(sessionExpired(new Error('401'))).toBe(false)
    expect(sessionExpired(null)).toBe(false)
  })
})

describe('controller polling', () => {
  it('backs off exponentially while offline, capped at 30 seconds', () => {
    const delays = [0, 1, 2, 3, 4, 5, 50].map(attempts => pollDelay({ offline: true, attempts, active: true, idleMs: 8000 }))
    expect(delays).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000])
  })
  it('polls fast while work runs and at the idle interval otherwise', () => {
    expect(pollDelay({ offline: false, attempts: 3, active: true, idleMs: 10000 })).toBe(2000)
    expect(pollDelay({ offline: false, attempts: 0, active: false, idleMs: 10000 })).toBe(10000)
    expect(pollDelay({ offline: false, attempts: 0, active: false, idleMs: 8000 })).toBe(8000)
  })
})
