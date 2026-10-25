import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

// Capture the current application UI with disposable API fixtures, never live accounts.
for (const theme of ['light', 'dark']) {
  test(`README screenshots in ${theme} mode`, async ({ page }, info) => {
    await page.addInitScript(theme => {
      localStorage.setItem('nelcota.locale', 'en')
      localStorage.setItem('mode-watcher-mode', theme)
    }, theme)
    await fixture(page, 'en')
    await page.route('**/health', route => route.fulfill({ json: { status: 'ok' } }))
    await page.setViewportSize({ width: 1440, height: 1000 })
    for (const [name, path, heading] of [
      ['overview', '/admin/', 'Overview'],
      ['table', '/admin/tables/notes', 'notes'],
      ['storage', '/admin/storage/documents', 'documents'],
    ]) {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: info.outputPath(`panel-${name}-${theme}.png`), fullPage: true, animations: 'disabled' })
    }
    await page.route('**/admin/api/session', route => route.fulfill({ status: 401, json: { code: 'session_expired' } }))
    await page.goto('/admin/')
    await expect(page.getByRole('heading', { name: 'Sign in to Nelcota' })).toBeVisible()
    await expect(page.getByText('nelcota-demo', { exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.getByRole('heading', { name: 'Sign in to Nelcota' }).click()
    await page.screenshot({ path: info.outputPath(`panel-login-${theme}.png`), fullPage: true, animations: 'disabled' })
  })
}
