import { test, expect, type Page } from '@playwright/test'
import { fixture } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('nelcota.locale')) localStorage.setItem('nelcota.locale', 'en')
  })
  await fixture(page)
  await page.route('**/health', route => route.fulfill({ json: { status: 'ok' } }))
})

async function openUser(page: Page) {
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'New user', exact: true }).first().click()
  await expect(page.locator('#new-user-email')).toBeVisible()
}

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

test('Back and Forward protect dirty drafts and preserve history after cancelling', async ({ page }) => {
  await page.goto('/admin/storage')
  await page.locator('header').getByRole('link', { name: 'Users', exact: true }).first().click()
  await page.getByRole('button', { name: 'New user', exact: true }).first().click()
  await page.locator('#new-user-email').fill('draft@example.test')
  await page.evaluate(() => history.back())
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.locator('#new-user-email')).toHaveValue('draft@example.test')
  await page.evaluate(() => history.back())
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/storage$/)
  await page.evaluate(() => history.forward())
  await expect(page).toHaveURL(/\/admin\/users$/)
  await page.getByRole('button', { name: 'New user', exact: true }).first().click()
  await page.locator('#new-user-email').fill('second@example.test')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/users$/)
})

test('global search cannot take focus or discard a draft behind an active dialog', async ({ page }) => {
  await openUser(page)
  await page.locator('#new-user-email').fill('draft@example.test')
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await expect(page.locator('#new-user-email')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.locator('#new-user-email')).toHaveValue('draft@example.test')
})

test('internal navigation and reload respect the active draft and explicit discard', async ({ page }) => {
  await openUser(page)
  await page.locator('#new-user-email').fill('draft@example.test')
  expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true)
  // Dispatch the same link action used by shell navigation while the modal is
  // active; the shared router must also guard programmatic navigation.
  const storage = page.locator('header a[href="/admin/storage"]').first()
  await storage.evaluate(e => (e as HTMLAnchorElement).click())
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.locator('#new-user-email')).toHaveValue('draft@example.test')
  await storage.evaluate(e => (e as HTMLAnchorElement).click())
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/storage$/)
  expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(false)
})

test('discard confirmation preserves a history jump across hash entries', async ({ page }) => {
  await page.goto('/admin/connect')
  await page.locator('main a[href="#api-sdk"]').first().click()
  await expect(page).toHaveURL(/#api-sdk$/)
  await page.locator('header a[href="/admin/users"]:visible').click()
  await page.getByRole('button', { name: 'New user', exact: true }).first().click()
  await page.locator('#new-user-email').fill('history-draft@example.test')
  await page.evaluate(() => history.go(-2))
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await expect(page).toHaveURL(/\/admin\/users$/)
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await page.evaluate(() => history.go(-2))
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/connect$/)
  await page.evaluate(() => history.go(2))
  await expect(page).toHaveURL(/\/admin\/users$/)
})

test('a pending save blocks navigation and a successful save releases the guard', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/admin/api/users', async route => {
    await held
    await route.fulfill({ json: { id: '00000000-0000-4000-8000-000000000099', email: 'saved@example.test' } })
  })
  try {
    await openUser(page)
    await page.locator('#new-user-email').fill('saved@example.test')
    await page.locator('#new-user-password').fill('A sufficiently long password 42!')
    const sent = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/admin/api/users')
    await page.getByRole('dialog').locator('button[type="submit"]').click()
    await sent
    await page.locator('header a[href="/admin/storage"]').first().evaluate(e => (e as HTMLAnchorElement).click())
    await expect(page).toHaveURL(/\/admin\/users$/)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    release()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.locator('header a[href="/admin/storage"]:visible').click()
    await expect(page).toHaveURL(/\/admin\/storage$/)
  } finally { release() }
})
