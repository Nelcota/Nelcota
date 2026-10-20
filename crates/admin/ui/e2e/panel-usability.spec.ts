import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('nelcota.locale')) localStorage.setItem('nelcota.locale', 'en')
  })
  await fixture(page)
  await page.route('**/health', route => route.fulfill({ json: { status: 'ok' } }))
})

for (const bytes of [1, 1000, 16384, null]) {
  test(`bucket settings preserve an untouched ${bytes}-byte limit`, async ({ page }) => {
    await page.route('**/admin/api/storage', route => route.fulfill({ json: {
      enabled: true, backend: 'disk', max_file_size: 52428800, max_total_size: null, public_url: null,
      buckets: [{ id: 'documents', public: false, file_size_limit: bytes, allowed_mime_types: null,
        created_at: '2026-10-08T10:30:00Z', files: 0, bytes: 0 }],
    } }))
    const writes: unknown[] = []
    await page.route('**/admin/api/storage/buckets/documents', async route => {
      writes.push(route.request().postDataJSON())
      await route.fulfill({ json: {} })
    })
    await page.goto('/admin/storage')
    await page.getByRole('button', { name: 'Actions for documents', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit…', exact: true }).click()
    await page.locator('#bucket-types').fill('image/*')
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]).toMatchObject({ file_size_limit: bytes, allowed_mime_types: ['image/*'] })
    // Editing and explicitly clearing the limit remain separate user actions.
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Actions for documents', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit…', exact: true }).click()
    await page.locator('#bucket-limit').fill('0.5')
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => writes.length).toBe(2)
    expect(writes[1]).toMatchObject({ file_size_limit: 524288 })
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Actions for documents', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit…', exact: true }).click()
    await page.locator('#bucket-limit').fill('')
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => writes.length).toBe(3)
    expect(writes[2]).toMatchObject({ file_size_limit: null })
  })
}
