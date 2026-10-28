import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

test.use({ locale: 'en-US' })
test.beforeEach(async ({ page }) => {
  await fixture(page, 'en')
  await page.route('**/health', route => route.fulfill({ json: { status: 'healthy' } }))
})

test('empty and unknown list filters select All in the sidebar', async ({ page }) => {
  for (const path of ['tables', 'policies']) {
    for (const filter of ['', 'unknown']) {
      await page.goto(`/admin/${path}?filter=${filter}`)
      const selected = page.locator('.panel-sidebar [aria-current="page"]')
      await expect(selected).toHaveCount(1)
      await expect(selected).toHaveText('All')
    }
  }
})

test('an open filter draft follows Back and Forward', async ({ page }) => {
  await page.goto('/admin/tables/notes?title=eq.first')
  await page.getByRole('button', { name: /^Filter\b/ }).click()
  const value = page.getByRole('textbox', { name: 'value', exact: true })
  await expect(value).toHaveValue('first')
  await page.evaluate(async () => {
    const { navigate } = await import(new URL('/admin/src/lib/navigation/router.svelte.ts', location.href).href)
    navigate('/tables/notes?title=eq.second')
  })
  await expect(value).toHaveValue('second')
  await value.fill('unsaved draft')
  await page.goBack()
  await expect(value).toHaveValue('first')
  await page.goForward()
  await expect(value).toHaveValue('second')
})

test('the table search shortcut leaves an open dialog in control', async ({ page }) => {
  await page.goto('/admin/tables')
  await page.getByRole('button', { name: 'New table', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  const prevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(prevented).toBe(false)
})

test('repeated SQL run shortcuts cannot restore a previous error marker', async ({ page }) => {
  let runs = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/admin/api/sql', async route => {
    runs++
    if (runs === 1) {
      await route.fulfill({ json: { error: { message: 'Invalid query', code: '42601', detail: null, hint: null, position: 1 } } })
      return
    }
    await gate
    await route.fulfill({ json: { results: [], results_truncated: false } })
  })
  await page.goto('/admin/sql')
  const editor = page.locator('.cm-content[role="textbox"]')
  await editor.fill('bad')
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('.cm-sql-error')).toBeVisible()
  await editor.fill('select 1')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => runs).toBe(2)
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('.cm-sql-error')).toHaveCount(0)
  expect(runs).toBe(2)
  release()
})

for (const succeeds of [true, false]) {
  test(`navigation requested during a save resumes after ${succeeds ? 'success' : 'failure confirmation'}`, async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    await page.route('**/admin/api/users', async route => {
      if (route.request().method() !== 'POST') { await route.fallback(); return }
      await gate
      await route.fulfill(succeeds ? { json: { email: 'new@example.test' } } : { status: 503, json: { error: 'Temporarily unavailable', code: 'unavailable' } })
    })
    await page.goto('/admin/users')
    await page.getByRole('button', { name: 'New user', exact: true }).click()
    await page.locator('#new-user-email').fill('new@example.test')
    await page.locator('#new-user-password').fill('strong-password-123')
    const request = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/admin/api/users')
    await page.getByRole('button', { name: 'Create user', exact: true }).click()
    await request
    await page.evaluate(async () => {
      const { navigate } = await import(new URL('/admin/src/lib/navigation/router.svelte.ts', location.href).href)
      navigate('/tables')
    })
    await expect(page).toHaveURL(/\/admin\/users$/)
    release()
    if (!succeeds) {
      await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes', exact: true }).click()
    }
    await expect(page).toHaveURL(/\/admin\/tables$/)
  })
}
