import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

for (const locale of ['pt-BR', 'en']) {
  test(`empty tables have one welcome and a working primary action in ${locale}`, async ({ page }, info) => {
    await page.addInitScript(value => { localStorage.setItem('nelcota.locale', value); localStorage.setItem('mode-watcher-mode', 'dark') }, locale)
    await fixture(page)
    await page.route('**/health', route => route.fulfill({ json: { status: 'ok' } }))
    await page.route('**/admin/api/tables', route => route.fulfill({ json: { schema: 'public', tables: [] } }))
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.goto('/admin/tables')
    const title = locale === 'pt-BR' ? 'Crie sua primeira tabela' : 'Create your first table'
    const welcome = page.getByRole('region', { name: title, exact: true })
    await expect(welcome).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(locale === 'pt-BR' ? 'Tabelas' : 'Tables')
    const sidebar = page.getByRole('complementary', { name: locale === 'pt-BR' ? 'Lista de tabelas' : 'Table list' })
    await expect(sidebar).toHaveCount(0)
    await expect(page.getByRole('searchbox', { name: locale === 'pt-BR' ? 'Buscar tabelas…' : 'Search tables…' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: locale === 'pt-BR' ? 'Guia de tabelas' : 'Tables guide' })).toHaveAttribute('href', '/admin/guides/panel')
    await expect(page.getByRole('button', { name: locale === 'pt-BR' ? 'Nova tabela' : 'New table', exact: true })).toHaveCount(1)
    await page.screenshot({ path: info.outputPath(`empty-tables-${locale}-desktop.png`), fullPage: true })
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(welcome).toBeVisible()
      await expect(welcome.getByRole('button')).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: info.outputPath(`empty-tables-${locale}-mobile.png`), fullPage: true })
    await welcome.getByRole('button', { name: locale === 'pt-BR' ? 'Nova tabela' : 'New table', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog').getByRole('heading', { name: locale === 'pt-BR' ? 'Nova tabela' : 'New table', exact: true })).toBeVisible()
  })
}

test('a failed catalog request cannot appear as an empty project', async ({ page }) => {
  await fixture(page)
  let failed = true
  await page.route('**/admin/api/tables', route => route.fulfill(failed ? { status: 503, json: { error: 'Temporarily unavailable' } } : { json: { schema: 'public', tables: [] } }))
  await page.goto('/admin/tables')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Crie sua primeira tabela', exact: true })).toHaveCount(0)
  failed = false
  await page.getByRole('button', { name: 'Tentar de novo', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Crie sua primeira tabela', exact: true })).toBeVisible()
})

test('search with no matches keeps its clear action and existing tables', async ({ page }) => {
  await fixture(page)
  await page.goto('/admin/tables')
  const sidebar = page.getByRole('complementary', { name: 'Lista de tabelas' })
  await sidebar.getByRole('searchbox').fill('no-such-table')
  await expect(sidebar.locator('a[href="/admin/tables/notes"]')).toHaveCount(0)
  await sidebar.getByRole('button', { name: 'Limpar busca', exact: true }).first().click()
  await expect(sidebar.locator('a[href="/admin/tables/notes"]')).toBeVisible()
})
