import { test, expect, type Locator, type Page } from '@playwright/test'
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

async function fits(element: Locator) {
  await expect.poll(() => element.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1)
}

async function visibleHitTarget(element: Locator) {
  await expect(element).toBeInViewport({ ratio: 1 })
  expect(await element.evaluate(e => {
    const r = e.getBoundingClientRect()
    return [0.2, 0.5, 0.8].every(x => [0.2, 0.5, 0.8].every(y => {
      const hit = document.elementFromPoint(r.x + r.width * x, r.y + r.height * y)
      return hit !== null && (hit === e || e.contains(hit))
    }))
  })).toBe(true)
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

test('command palette and its last option fit a short landscape viewport', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 844, height: 390 })
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeInViewport({ ratio: 1 })
  await page.getByRole('combobox').press('End')
  await expect(dialog.getByRole('option').last()).toBeInViewport({ ratio: 1 })
})

test('long bucket identities wrap inside a narrow dialog', async ({ page }) => {
  const name = 'b'.repeat(63)
  await page.route('**/admin/api/storage', route => route.fulfill({ json: {
    enabled: true, backend: 'disk', max_file_size: 52428800, max_total_size: null, public_url: null,
    buckets: [{ id: name, public: false, file_size_limit: null, allowed_mime_types: null,
      created_at: '2026-10-08T10:30:00Z', files: 0, bytes: 0 }],
  } }))
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/admin/storage')
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit…', exact: true }).click()
  await fits(page.getByRole('dialog'))
  await expect(page.getByRole('dialog')).toContainText(name)
})

test('long account identities and password controls fit a narrow dialog', async ({ page }) => {
  const email = `${'a'.repeat(64)}@${'b'.repeat(60)}.example.test`
  await page.route('**/admin/api/users?*', route => route.fulfill({ json: { page: 0, total: 1, has_next: false,
    users: [{ id: '00000000-0000-4000-8000-000000000001', email, created_at: '2026-10-08T10:30:00Z',
      last_sign_in_at: null, email_confirmed_at: null, sessions: 0, has_password: true, providers: [] }],
  } }))
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto('/admin/users')
  await page.getByRole('button', { name: `Actions for ${email}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Reset password…', exact: true }).click()
  await fits(page.getByRole('dialog'))
  expect((await page.locator('#reset-password').boundingBox())?.width).toBeGreaterThan(180)
})

test('account and project remain readable at intermediate widths in both languages', async ({ page }) => {
  for (const locale of ['en', 'pt-BR']) {
    await page.evaluate(locale => localStorage.setItem('nelcota.locale', locale), locale)
    await page.reload()
    for (const width of [768, 1024, 1100, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      const account = page.getByRole('button', { name: locale === 'en' ? 'Account' : 'Conta', exact: true })
      expect((await account.boundingBox())?.width).toBeGreaterThanOrEqual(44)
      await visibleHitTarget(account)
      await fits(page.locator('header'))
    }
  }
  await page.setViewportSize({ width: 320, height: 740 })
  await expect(page.locator('header').getByText('nelcota-demo', { exact: true }).first()).toBeVisible()
  await fits(page.locator('header'))
})

test('enlarged text reflows the header and overview without occluding controls', async ({ page }) => {
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
  for (const link of await page.locator('header a:visible').all()) await visibleHitTarget(link)
  await visibleHitTarget(page.getByRole('button', { name: 'Account', exact: true }))
  const headline = page.getByRole('heading', { name: 'Overview', exact: true }).locator('..').locator('..')
  await fits(headline)
  for (const link of await headline.getByRole('link').all()) await visibleHitTarget(link)
})

test('webhook status and help links have readable contrast in the light theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.route('**/admin/api/webhooks**', route => route.fulfill({ json: route.request().url().includes('/deliveries')
    ? { deliveries: [], next_cursor: null }
    : { endpoints: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Orders', schema: 'public', table: 'notes', table_available: true, url: 'https://example.test/hook', events: ['INSERT'], enabled: true, max_attempts: 6, created_at: '2026-10-08T10:30:00Z' }], tables: ['notes'], allow_loopback: false, outstanding: 0, retained: 0 },
  }))
  await page.goto('/admin/webhooks')
  const elements = [page.getByText('Active', { exact: true }), page.locator('main a[href="/admin/guides/webhooks"]').last()]
  for (const element of elements) {
    await expect(element).toBeVisible()
    const contrast = await element.evaluate(e => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1, 1)
      const parents: Element[] = []
      for (let p: Element | null = e; p; p = p.parentElement) parents.unshift(p)
      for (const p of parents) { ctx.fillStyle = getComputedStyle(p).backgroundColor; ctx.fillRect(0, 0, 1, 1) }
      const luminance = () => [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => {
        const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
      const bg = luminance(); ctx.fillStyle = getComputedStyle(e).color; ctx.fillRect(0, 0, 1, 1)
      const fg = luminance(); return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  }
})

test('updates distinguishes loading, enrollment and a retryable failure', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let fail = false
  let version = '0.5.0'
  let origin: string | null = 'https://updates.example.test'
  await page.route('**/admin/api/updates', async route => {
    await held
    if (fail) { await route.fulfill({ status: 503, json: { error: 'Unavailable' } }); return }
    await route.fulfill({ json: { version, controller_origin: origin } })
  })
  try {
    await page.goto('/admin/updates')
    await expect(page.getByRole('heading', { name: 'Updates', exact: true })).toBeVisible()
    await expect(page.getByText('This host has not been enrolled for panel updates.', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('status')).toContainText('Loading')
    release()
    await expect(page.getByRole('link', { name: 'Open update management', exact: true })).toBeVisible()
    origin = null; await page.reload()
    await expect(page.getByText('This host has not been enrolled for panel updates.', { exact: true })).toBeVisible()
    version = ''; await page.reload()
    await expect(page.locator('main strong')).toHaveText('…')
    fail = true; await page.reload()
    await expect(page.getByRole('alert')).toBeVisible()
    fail = false
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByText('This host has not been enrolled for panel updates.', { exact: true })).toBeVisible()
  } finally { release() }
})

test('password entry gets a full row on a small phone', async ({ page }) => {
  await openUser(page)
  await page.setViewportSize({ width: 320, height: 740 })
  await fits(page.getByRole('dialog'))
  expect((await page.locator('#new-user-password').boundingBox())?.width).toBeGreaterThan(180)
  await page.getByRole('button', { name: 'Generate', exact: true }).click()
  await expect(page.locator('#new-user-password')).not.toHaveValue('')
  await expect(page.getByRole('button', { name: 'Copy password', exact: true })).toBeEnabled()
})
