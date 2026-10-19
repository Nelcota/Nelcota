import { describe, expect, it, vi } from 'vitest'
import { readBody } from './read-body'

describe('response budget cleanup', () => {
  it.each([true, false])('does not wait for cancellation after overflow (declared: %s)', async declared => {
    let release!: () => void
    const cleanup = new Promise<void>(resolve => { release = resolve })
    const cancel = vi.fn(() => cleanup)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(2)) },
      cancel,
    }, { highWaterMark: 0 })
    const response = new Response(body, { headers: declared ? { 'content-length': '2' } : undefined })
    const pending = readBody(response, 1)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        pending,
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('cleanup is still pending'), 100) }),
      ])
      expect(result).toBeNull()
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
    } finally {
      clearTimeout(timer)
      release()
      await pending
    }
  })

  it.each([true, false])('ignores a failed cleanup after overflow (declared: %s)', async declared => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(2)) },
      cancel() { return Promise.reject(new Error('cleanup failed')) },
    }, { highWaterMark: 0 })
    const response = new Response(body, { headers: declared ? { 'content-length': '2' } : undefined })
    await expect(readBody(response, 1)).resolves.toBeNull()
    expect(body.locked).toBe(false)
  })
})
