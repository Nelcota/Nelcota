import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'
import { expectReadable } from './accessibility'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nelcota.locale', 'en'))
  await fixture(page)
  await page.route('**/health', route => route.fulfill({ json: { status: 'ok' } }))
})

test('mobile navigation exposes its state and returns focus after Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const trigger = page.getByRole('button', { name: 'Menu', exact: true })
  await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('a failed project list does not leave a dead enabled switcher', async ({ page }) => {
  await page.route('**/admin/api/projects', route => route.fulfill({ status: 503, json: { error: 'Projects unavailable' } }))
  await page.reload()
  const trigger = page.getByRole('button', { name: /^Switch project:/ })
  await expect(trigger).toBeDisabled()
  await expect(trigger).toHaveAttribute('aria-busy', 'false')
  await expect(trigger).toHaveAttribute('title', /unavailable/i)
  await expect(page.locator('.panel-sidebar').getByRole('link', { name: 'Projects', exact: true })).toBeVisible()
})

for (const endpoint of ['overview', 'metrics', 'denied']) {
  test(`overview ${endpoint} failure stops skeletons and offers a working retry`, async ({ page }) => {
    let fail = true
    await page.route(`**/admin/api/${endpoint}${endpoint === 'metrics' ? '?*' : ''}`, async route => {
      if (fail) return route.fulfill({ status: 503, json: { error: `${endpoint} unavailable` } })
      await route.fallback()
    })
    await page.reload()
    const error = page.locator('main').getByRole('alert')
    await expect(error).toHaveCount(1)
    await expect.poll(() => error.locator('p').last().evaluate(e => e.clientWidth)).toBeGreaterThanOrEqual(140)
    await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0)
    fail = false
    await error.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(error).toHaveCount(0)
    await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0)
  })
}

test('pending destructive confirmation survives Escape and cannot run twice', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  await page.route('**/admin/api/users/*', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    writes++
    await held
    await route.fulfill({ status: 503, json: { error: 'Delete unavailable' } })
  })
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Actions for ana@example.test', exact: true }).first().click()
  await page.getByRole('menuitem', { name: 'Delete user', exact: true }).click()
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => writes).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-busy', 'true')
  await expect(dialog.getByRole('button', { name: 'Working…', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  release()
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled()
  await expect(dialog).toBeVisible()
  expect(writes).toBe(1)
})

test('small shortcut text and protected badges retain AA contrast in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => localStorage.setItem('mode-watcher-mode', theme), theme)
    await page.goto('/admin/tables/notes')
    await expect.poll(() => page.locator('html').evaluate(e => e.classList.contains('dark'))).toBe(theme === 'dark')
    for (const element of [page.locator('header kbd'), page.getByRole('main').getByText('Protected', { exact: true }).first()]) {
      await expectReadable(element)
    }
  }
})

test('field type hints remain readable in a narrow row editor', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('mode-watcher-mode', 'light'))
  await page.goto('/admin/tables/notes')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Insert row', exact: true }).click()
  await expectReadable(page.getByRole('dialog').getByText('uuid', { exact: true }))
})

for (const theme of ['light', 'dark']) {
  test(`destructive actions remain readable before and during hover in ${theme}`, async ({ page }) => {
    await page.evaluate(theme => localStorage.setItem('mode-watcher-mode', theme), theme)
    await page.goto('/admin/users')
    await page.getByRole('button', { name: 'Actions for ana@example.test', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Delete user', exact: true }).click()
    const action = page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true })
    await expectReadable(action)
    await action.hover()
    await expect.poll(() => action.evaluate(e => e.getAnimations().filter(a => a.playState === 'running').length)).toBe(0)
    await expectReadable(action)
  })
}
