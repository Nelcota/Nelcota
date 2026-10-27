import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nelcota.locale', 'pt-BR')
    if (!localStorage.getItem('mode-watcher-mode')) localStorage.setItem('mode-watcher-mode', 'dark')
  })
  await fixture(page)
  await page.route('**/health', route => route.fulfill({ json: { status: 'ok' } }))
  await page.reload()
})

test('workspace navigation keeps database tools, breadcrumbs and search usable', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible()
  const navigation = page.locator('.panel-sidebar')
  await page.keyboard.press('Tab')
  await navigation.getByRole('button', { name: 'Banco de dados', exact: true }).click()
  await navigation.getByRole('link', { name: 'Editor SQL', exact: true }).click()
  await expect(page).toHaveURL(/\/admin\/sql$/)
  await expect(page.getByRole('main')).toBeFocused()
  await expect(page.getByRole('main')).toHaveCSS('outline-style', 'none')
  await expect(navigation.getByRole('button', { name: 'Banco de dados', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(navigation.getByRole('link', { name: 'Editor SQL', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: 'Localização atual' })).toContainText('Editor SQL')
  await page.getByRole('button', { name: /Buscar \(/ }).click()
  await expect(page.getByRole('combobox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox')).toHaveCount(0)
})

test('mobile menu closes on navigation and returns focus to the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const menu = page.getByRole('dialog')
  await expect(menu).toBeVisible()
  await menu.getByRole('link', { name: 'Armazenamento', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Armazenamento', exact: true })).toBeVisible()
  await expect(page.locator('main')).toBeFocused()
  await expect(page.locator('main')).toHaveCSS('outline-style', 'none')
  await expect(page.getByRole('button', { name: /Buscar \(/ })).toBeVisible()
})

test('workspace reflows without horizontal overflow in both themes', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => localStorage.setItem('mode-watcher-mode', theme), theme)
    await page.reload()
    await expect.poll(() => page.locator('html').evaluate(e => e.classList.contains('dark'))).toBe(theme === 'dark')
    await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible()
    await expect(page.locator('img[src*="nelcota-"]:visible')).toHaveCount(1)
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
      await expect.poll(() => page.locator('main').evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1)
      const cards = page.getByRole('region', { name: 'Recursos do projeto' }).locator('article')
      await expect(cards).toHaveCount(3)
      for (const card of await cards.all()) {
        await expect.poll(() => card.evaluate(e => e.clientWidth)).toBeGreaterThanOrEqual(220)
      }
      const account = page.getByRole('button', { name: 'Conta', exact: true })
      await expect(account).toBeInViewport({ ratio: 1 })
      await expect(page.getByRole('region', { name: 'Recursos do projeto' })).toBeVisible()
    }
  }
})

test('visual review captures real resource cards and table editing surfaces', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await expect(page.getByRole('region', { name: 'Recursos do projeto' })).toContainText('Banco de dados')
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: testInfo.outputPath('overview-desktop.png'), fullPage: true })
  await page.goto('/admin/tables/notes')
  await expect(page.getByRole('gridcell', { name: 'Planejamento da semana', exact: true }).first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('tables-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/admin/')
  await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('overview-mobile.png'), fullPage: true })
})
