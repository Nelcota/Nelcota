import { expect, test } from '@playwright/test'
import { fixture } from './fixtures'

for (const declared of [true, false]) {
  test(`oversized upload reply is rejected before parsing (declared: ${declared})`, async ({ page }) => {
    await fixture(page)
    await page.route('**/admin/api/upload-test', route => route.fulfill({ status: 503, contentType: 'text/plain', body: 'x'.repeat(1024 * 1024) }))
    await page.goto('/admin/storage/documents')
    const result = await page.evaluate(async declared => {
      const { upload } = await import(new URL('/admin/src/lib/transport/upload.ts', location.href).href)
      const descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText')!
      const getHeader = XMLHttpRequest.prototype.getResponseHeader
      let textReads = 0, parsed = 0
      Object.defineProperty(XMLHttpRequest.prototype, 'responseText', { ...descriptor, get() { textReads++; return descriptor.get!.call(this) } })
      if (!declared) XMLHttpRequest.prototype.getResponseHeader = function(name) { return name.toLowerCase() === 'content-length' ? null : getHeader.call(this, name) }
      try {
        await upload('/upload-test', new File(['test'], 'test.txt'), async () => { parsed++; return {} })
        return { parsed, textReads, status: 200, code: '' }
      } catch (error) {
        const reply = error as { status?: number; code?: string }
        return { parsed, textReads, status: reply.status, code: reply.code }
      } finally {
        Object.defineProperty(XMLHttpRequest.prototype, 'responseText', descriptor)
        XMLHttpRequest.prototype.getResponseHeader = getHeader
      }
    }, declared)
    expect(result).toEqual({ parsed: 0, textReads: 0, status: 503, code: 'server_unreachable' })
  })
}

test('blob reception preserves normal upload responses and conflict errors', async ({ page }) => {
  await fixture(page)
  let calls = 0
  await page.route('**/admin/api/upload-test', route => ++calls === 1
    ? route.fulfill({ json: { saved: true } })
    : route.fulfill({ status: 409, json: { code: 'object_exists', error: 'Already exists' } }))
  await page.goto('/admin/storage/documents')
  const result = await page.evaluate(async () => {
    const { upload } = await import(new URL('/admin/src/lib/transport/upload.ts', location.href).href)
    const { parseResponse } = await import(new URL('/admin/src/lib/transport/api.ts', location.href).href)
    const send = () => upload('/upload-test', new File(['test'], 'test.txt'), (response: Response) => parseResponse(response, '/upload-test', 'POST'))
    const saved = await send()
    try { await send(); return { saved, status: 200, code: '' } }
    catch (error) {
      const reply = error as { status?: number; code?: string }
      return { saved, status: reply.status, code: reply.code }
    }
  })
  expect(result).toEqual({ saved: { saved: true }, status: 409, code: 'object_exists' })
})

test('an oversized unauthorized upload expires the panel session', async ({ page }) => {
  await fixture(page)
  await page.route('**/admin/api/upload-test', route => route.fulfill({ status: 401, body: 'x'.repeat(1024 * 1024) }))
  await page.goto('/admin/storage/documents')
  const result = await page.evaluate(async () => {
    const { uploadFile } = await import(new URL('/admin/src/lib/transport/api.ts', location.href).href)
    const { session } = await import(new URL('/admin/src/lib/resources/session.svelte.ts', location.href).href)
    session.email = 'admin@example.test'
    try { await uploadFile('/upload-test', new File(['test'], 'test.txt')) }
    catch (error) { return { status: (error as { status?: number }).status, email: session.email, expired: session.expired } }
    return null
  })
  expect(result).toEqual({ status: 401, email: null, expired: true })
})

for (const bytes of [32, 1024 * 1024]) {
  test(`a late unauthorized upload of ${bytes} bytes cannot expire a newer login`, async ({ page }) => {
    await fixture(page)
    let finish!: () => Promise<void>
    await page.route('**/admin/api/upload-test', route => new Promise<void>(resolve => {
      finish = async () => { await route.fulfill({ status: 401, body: 'x'.repeat(bytes) }); resolve() }
    }))
    await page.goto('/admin/storage/documents')
    await page.evaluate(async () => {
      const { uploadFile } = await import(new URL('/admin/src/lib/transport/api.ts', location.href).href)
      Object.assign(window, { oldUpload: uploadFile('/upload-test', new File(['test'], 'test.txt')).catch(() => null) })
    })
    await expect.poll(() => typeof finish).toBe('function')
    await page.evaluate(async () => {
      const { api } = await import(new URL('/admin/src/lib/transport/api.ts', location.href).href)
      const { session } = await import(new URL('/admin/src/lib/resources/session.svelte.ts', location.href).href)
      const me = await api.post('/login')
      session.email = me.email
      session.expired = false
    })
    await finish()
    const result = await page.evaluate(async () => {
      await Reflect.get(window, 'oldUpload')
      const { session } = await import(new URL('/admin/src/lib/resources/session.svelte.ts', location.href).href)
      return { email: session.email, expired: session.expired }
    })
    expect(result).toEqual({ email: 'admin@example.test', expired: false })
  })
}
