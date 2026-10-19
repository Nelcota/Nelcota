import { describe, expect, it, vi } from 'vitest'
import { guardUploadResponse } from './upload-response'

class Reply extends EventTarget {
  readyState = 1
  constructor(public length: string | null) { super() }
  getResponseHeader() { return this.length }
  headers() { this.readyState = 2; this.dispatchEvent(new Event('readystatechange')) }
  progress(loaded: number) { this.dispatchEvent(Object.assign(new Event('progress'), { loaded })) }
}

describe('XHR upload response budget', () => {
  it('stops an oversized declared reply at its headers', () => {
    const xhr = new Reply('65537')
    const overflow = vi.fn()
    guardUploadResponse(xhr as unknown as XMLHttpRequest, 65536, overflow)
    xhr.headers()
    xhr.progress(65537)
    expect(overflow).toHaveBeenCalledOnce()
  })

  it.each([null, '1', 'invalid'])('stops reception despite content-length %j', length => {
    const xhr = new Reply(length)
    const overflow = vi.fn()
    guardUploadResponse(xhr as unknown as XMLHttpRequest, 65536, overflow)
    xhr.headers()
    xhr.progress(65536)
    expect(overflow).not.toHaveBeenCalled()
    xhr.progress(65537)
    xhr.progress(100000)
    expect(overflow).toHaveBeenCalledOnce()
  })

  it.each(['loadend', 'dispose'])('removes listeners after %s', mode => {
    const xhr = new Reply('1')
    const overflow = vi.fn()
    const cleanup = guardUploadResponse(xhr as unknown as XMLHttpRequest, 1, overflow)
    switch (mode) {
      case 'loadend': xhr.dispatchEvent(new Event('loadend')); break
      default: cleanup(); break
    }
    xhr.progress(2)
    expect(overflow).not.toHaveBeenCalled()
  })
})
