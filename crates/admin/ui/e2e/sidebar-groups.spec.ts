import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

test.beforeEach(async ({ page }) => {
  await fixture(page)
  await page.route('**/health', r => r.fulfill({ json: { status: 'ok' } }))
  await page.route('**/admin/api/webhooks**', r => r.fulfill({ json: r.request().url().includes('/deliveries') ? { deliveries: [], next_cursor: null } : { endpoints: [], tables: ['notes'], allow_loopback: false, outstanding: 0, retained: 0 } }))
})

test('database and users have nested links with one selected leaf and no duplicate tabs', async ({ page }) => {
  const sidebar = page.locator('.panel-sidebar')
  await page.goto('/admin/sql')
  await expect(sidebar.getByRole('button', { name: 'Banco de dados', exact: true })).toHaveAttribute('aria-expanded', 'true')
  for (const [label, path] of [['Tabelas', '/tables'], ['Editor SQL', '/sql'], ['Migrações', '/migrations']] as const) {
    await sidebar.getByRole('link', { name: label, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/admin${path}$`))
    await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1)
    await expect(sidebar.getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('main').getByRole('navigation', { name: 'Seções do banco de dados' })).toHaveCount(0)
  }
  await sidebar.getByRole('button', { name: 'Usuários', exact: true }).click()
  await sidebar.getByRole('link', { name: 'Login dos usuários', exact: true }).click()
  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(sidebar.getByRole('link', { name: 'Login dos usuários', exact: true })).toHaveAttribute('aria-current', 'page')
  await sidebar.getByRole('link', { name: 'Lista de usuários', exact: true }).click()
  await expect(page).toHaveURL(/\/users$/)
  await expect(page.locator('main .panel-segments')).toHaveCount(0)
})

test('webhook history is selected for query filters and back navigation', async ({ page }) => {
  const sidebar = page.locator('.panel-sidebar')
  await page.goto('/admin/webhooks?tab=deliveries&status=failed')
  const history = sidebar.getByRole('link', { name: 'Histórico de entregas', exact: true })
  await expect(history).toHaveAttribute('aria-current', 'page')
  await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1)
  await expect(page.locator('main .panel-segments [aria-current="page"]')).toHaveText('Histórico de entregas')
  await sidebar.getByRole('link', { name: 'Webhooks', exact: true }).click()
  await expect(history).not.toHaveAttribute('aria-current', 'page')
  await page.goBack()
  await expect(history).toHaveAttribute('aria-current', 'page')
})

test('API outline scrolls to the chosen section and preserves example settings', async ({ page }) => {
  await page.goto('/admin/connect?lang=curl&topic=auth')
  const sidebar = page.locator('.panel-sidebar')
  const sdk = sidebar.locator('a[href*="section=api-sdk"]')
  await sdk.click()
  await expect(page).toHaveURL(/lang=curl&topic=auth&section=api-sdk/)
  await expect(sdk).toHaveAttribute('aria-current', 'location')
  await expect.poll(() => page.locator('#api-sdk').evaluate(e => {
    const root = document.getElementById('conteudo')!
    const rect = e.getBoundingClientRect(), bounds = root.getBoundingClientRect()
    return rect.top >= bounds.top - 1 && rect.top < bounds.bottom
  })).toBe(true)
  const selectedTop = await page.locator('#api-sdk').evaluate(e => e.getBoundingClientRect().top)
  await page.locator('#api-address').scrollIntoViewIfNeeded()
  await expect(sdk).not.toHaveAttribute('aria-current', 'location')
  await sdk.click()
  await expect.poll(() => page.locator('#api-sdk').evaluate((e, top) => Math.abs(e.getBoundingClientRect().top - top), selectedTop)).toBeLessThanOrEqual(1)
  await expect(page.locator('main .panel-segments-scroll')).toHaveCount(0)
  await page.locator('#api-examples').scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: 'JavaScript', exact: true }).click()
  await expect(page).toHaveURL(/lang=js/)
  await expect.poll(() => page.locator('#api-examples').evaluate(e => {
    const root = document.getElementById('conteudo')!
    const rect = e.getBoundingClientRect(), bounds = root.getBoundingClientRect()
    return rect.bottom > bounds.top && rect.top < bounds.bottom
  })).toBe(true)
})

test('mobile groups support keyboard expansion, child selection and focus return', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const menu = page.getByRole('dialog')
  const group = menu.getByRole('button', { name: 'Banco de dados', exact: true })
  await group.focus()
  await page.keyboard.press('Enter')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await menu.getByRole('link', { name: 'Editor SQL', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(page).toHaveURL(/\/sql$/)
  await expect.poll(() => page.locator('main').evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(menu.getByRole('link', { name: 'Editor SQL', exact: true })).toHaveAttribute('aria-current', 'page')
  await menu.getByRole('button', { name: 'API', exact: true }).click()
  await menu.locator('a[href*="section=api-sdk"]').click()
  await expect(menu).toHaveCount(0)
  await expect(page).toHaveURL(/connect\?section=api-sdk/)
  await expect.poll(() => page.locator('#api-sdk').evaluate(e => {
    const root = document.getElementById('conteudo')!
    return e.getBoundingClientRect().top < root.getBoundingClientRect().bottom
  })).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
