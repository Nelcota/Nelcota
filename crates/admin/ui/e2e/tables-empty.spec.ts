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

test('the tables home search and the sidebar search keep their clear actions', async ({ page }) => {
  await fixture(page)
  await page.goto('/admin/tables')
  // The home lists every table itself: no second list beside it.
  await expect(page.getByRole('complementary', { name: 'Lista de tabelas' })).toHaveCount(0)
  const main = page.getByRole('main')
  await expect(main.getByRole('link', { name: 'notes', exact: true })).toBeVisible()
  await page.keyboard.press('/')
  await expect(main.getByRole('searchbox', { name: 'Buscar tabelas…' })).toBeFocused()
  await page.keyboard.type('no-such-table')
  await expect(main.getByText('Nenhuma tabela encontrada.')).toBeVisible()
  await main.getByRole('button', { name: 'Limpar busca', exact: true }).click()
  await expect(main.getByRole('link', { name: 'notes', exact: true })).toBeVisible()
  // With a table open, the sidebar list returns with its own search.
  await page.goto('/admin/tables/notes')
  const sidebar = page.getByRole('complementary', { name: 'Lista de tabelas' })
  await sidebar.getByRole('searchbox').fill('no-such-table')
  await expect(sidebar.locator('a[href="/admin/tables/notes"]')).toHaveCount(0)
  await sidebar.getByRole('button', { name: 'Limpar busca', exact: true }).first().click()
  await expect(sidebar.locator('a[href="/admin/tables/notes"]')).toBeVisible()
})

test('the tables home lists, filters, orders and fixes tables', async ({ page }) => {
  await fixture(page)
  await page.addInitScript(() => localStorage.setItem('nelcota:tables-last', 'notes'))
  const rls = (state: string, policies = 0) => ({ state, label: state, enabled: state === 'ok' || state === 'warn', forced: false, policies })
  let openDataState = 'danger'
  const tables = () => [
    { name: 'notes', kind: 'table', has_pk: true, rls: rls('ok', 2) },
    { name: 'open_data', kind: 'table', has_pk: true, rls: rls(openDataState, 1) },
    { name: 'balances', kind: 'view', has_pk: false, rls: rls('view') },
  ]
  await page.route('**/admin/api/tables', route => route.fulfill({ json: { schema: 'public', tables: tables() } }))
  let altered: unknown = null
  await page.route('**/admin/api/tables/open_data', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    altered = route.request().postDataJSON()
    openDataState = 'ok'
    await route.fulfill({ json: { sql: [], applied: true, catalog_pending: false } })
  })
  await page.route('**/admin/api/schema', route => route.fulfill({ json: { schema: 'public', tables: { notes: ['id', 'title', 'owner'], open_data: ['id'], balances: ['org', 'total'] } } }))
  await page.route('**/admin/api/overview', route => route.fulfill({ json: {
    schema: 'public', counts: { tables: 3, users: 0, signed_in_users: 0, policies: 3, functions: 0 }, exposed_without_rls: openDataState === 'danger' ? ['open_data'] : [],
    tables: [
      { ...tables()[0], comment: 'Notas de cada usuário', rows: 1234, rows_exact: true, grants: { anon: [], authenticated: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] } },
      { ...tables()[1], comment: null, rows: 5, rows_exact: true, grants: { anon: ['SELECT'], authenticated: ['SELECT'] } },
      { ...tables()[2], comment: null, rows: null, rows_exact: false, grants: { anon: [], authenticated: ['SELECT'] } },
    ],
  } }))
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/admin/tables')
  const main = page.getByRole('main')
  const list = main.getByRole('table', { name: 'Tabelas' })
  const row = (name: string) => main.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) })

  await expect(main.getByRole('heading', { level: 1 })).toContainText('Tabelas')
  await expect(row('notes')).toContainText('3 colunas')
  await expect(row('notes')).toContainText('1.234 linhas')
  await expect(row('notes')).toContainText('Notas de cada usuário')
  await expect(row('notes')).toContainText('Usuários logados: Leitura e escrita')
  await expect(row('open_data')).toContainText('Visitantes: Só leitura')
  await expect(row('open_data')).not.toContainText('Usuários logados')
  await expect(row('balances')).toContainText('Somente leitura')
  // The previously opened table is offered again, migrated from the old single entry.
  await expect(main.getByRole('navigation', { name: 'Recentes' }).getByRole('link', { name: 'notes' })).toBeVisible()

  // Views come after the tables; rows sort largest first.
  const names = async () => main.locator('table tbody a[href^="/admin/tables/"]').allTextContents()
  expect(await names()).toEqual(['notes', 'open_data', 'balances'])
  await list.getByRole('button', { name: 'Linhas' }).click()
  expect(await names()).toEqual(['notes', 'open_data', 'balances'])
  await list.getByRole('button', { name: 'Linhas' }).click()
  expect(await names()).toEqual(['open_data', 'notes', 'balances'])

  // The filters are sub-items of Tables in the sidebar, kept in the URL.
  const sidebar = page.locator('.panel-sidebar')
  await expect(main.locator('.panel-segments')).toHaveCount(0)
  const tablesGroup = sidebar.getByRole('button', { name: 'Tabelas', exact: true })
  await expect(tablesGroup).toHaveAttribute('aria-expanded', 'true')
  await expect(sidebar.getByRole('link', { name: 'Todas', exact: true })).toHaveAttribute('aria-current', 'page')
  await sidebar.getByRole('link', { name: 'Atenção', exact: true }).click()
  await expect(page).toHaveURL(/\/tables\?filter=attention$/)
  await expect(sidebar.locator('[aria-current="page"]')).toHaveText('Atenção')
  expect(await names()).toEqual(['open_data'])
  await sidebar.getByRole('link', { name: 'Views', exact: true }).click()
  expect(await names()).toEqual(['balances'])
  await sidebar.getByRole('link', { name: 'Todas', exact: true }).click()
  await expect(page).toHaveURL(/\/tables$/)
  // The group folds like every other one.
  await tablesGroup.click()
  await expect(tablesGroup).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar.getByRole('link', { name: 'Views', exact: true })).toBeHidden()

  // The attention panel turns protection on in place (with rules, no confirmation).
  const attention = main.getByRole('region', { name: '1 tabela precisa de atenção' })
  await attention.getByRole('button', { name: 'Ativar proteção por linha (RLS)' }).click()
  await expect.poll(() => altered).toEqual({ actions: [{ action: 'set_rls', enabled: true }], preview: false })
  await expect(attention).toHaveCount(0)
  await expect(row('open_data')).toContainText('Protegida')

  // Each row's menu reaches the table's other tools.
  await row('notes').getByRole('button', { name: 'Ações de notes' }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Exportar CSV' })).toHaveAttribute('href', '/admin/api/tables/notes/export?format=csv')
  await expect(menu.getByRole('menuitem', { name: 'Regras de acesso' })).toHaveAttribute('href', '/admin/policies?table=notes')
  await menu.getByRole('menuitem', { name: 'Consultar no SQL' }).click()
  await expect(page).toHaveURL(/\/admin\/sql$/)

  await page.goto('/admin/tables')
  await row('balances').getByRole('button', { name: 'Ações de balances' }).click()
  await expect(page.getByRole('menuitem', { name: 'Apagar…' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Clicking anywhere on a row opens the table.
  await row('open_data').getByRole('cell').nth(2).click()
  await expect(page).toHaveURL(/\/admin\/tables\/open_data$/)

  await page.goto('/admin/tables')
  for (const width of [1600, 1280, 390]) {
    await page.setViewportSize({ width, height: 844 })
    const name = await list.getByRole('link', { name: 'open_data', exact: true }).boundingBox()
    // Views share the tables' columns at every width.
    const tableCell = await row('notes').getByRole('cell').last().boundingBox()
    const viewCell = await row('balances').getByRole('cell').last().boundingBox()
    expect(viewCell?.x).toBe(tableCell?.x)
    expect(name?.width ?? 0).toBeGreaterThan(60)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await expect(main.getByRole('button', { name: 'Nova tabela', exact: true })).toBeVisible()
})
