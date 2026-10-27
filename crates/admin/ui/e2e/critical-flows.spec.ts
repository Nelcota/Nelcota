import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'
import { editing } from './editing'
import { draftsAndFiles } from './draftsAndFiles'
import { uploadsAndDetails } from './uploadsAndDetails'

test.beforeEach(async ({ page }) => { await fixture(page) })
const pageContracts = {
  '': ['/overview', '/metrics', '/denied'],
  policies: ['/policies'],
  migrations: ['/migrations'],
  storage: ['/storage'],
  'storage/documents': ['/storage', '/storage/buckets/documents/objects'],
  projects: ['/projects', '/projects/status'],
  connect: ['/tables'],
  'sign-in': ['/sign-in'],
}
for (const [route, endpoints] of Object.entries(pageContracts)) {
  test(`${route || 'overview'} loads its generated contract without an error`, async ({ page }) => {
    // Lazy modules and the Vite connection can outlive page readiness.
    // Check the actual data contracts and rendered loading state instead.
    // Connect builds an AI context from the generated types; the shared fixture
    // leaves that endpoint unmocked (a 404 would show an error alert).
    await page.route('**/admin/api/typescript', route => route.fulfill({ contentType: 'text/plain', body: 'export type Database = { public: { Tables: {} } }\n' }))
    const responses = endpoints.map(path => page.waitForResponse(response => new URL(response.url()).pathname === `/admin/api${path}`))
    await page.goto(`/admin/${route}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await Promise.all(responses.map(async pending => (await pending).finished()))
    await expect(page.locator('main [data-slot="skeleton"]')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
}
test('editing retains row identity, supports keyboard NULL and protects dirty drafts', async ({ page }) => {
  await page.goto('/admin/tables/notes')
  await page.locator('[data-cell="0:1"]').waitFor()
  await editing(page)
})
test('row selection and column visibility stay consistent in the table grid', async ({ page }) => {
  await page.goto('/admin/tables/notes')
  const all = page.getByRole('checkbox', { name: 'Selecionar todas as linhas da página', exact: true })
  const first = page.getByRole('checkbox', { name: 'Selecionar linha 1', exact: true })
  await all.check()
  await expect(page.getByRole('region', { name: 'Linhas selecionadas' })).toContainText('12 linhas selecionadas')
  await first.uncheck()
  await expect(all).toHaveAttribute('aria-checked', 'mixed')
  await expect(page.getByRole('region', { name: 'Linhas selecionadas' })).toContainText('11 linhas selecionadas')
  await page.getByRole('button', { name: 'Limpar seleção', exact: true }).click()
  await expect(all).not.toBeChecked()
  await expect(first).not.toBeChecked()
  await page.getByRole('button', { name: 'Opções da coluna title', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Ocultar coluna', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Opções da coluna title', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Opções da coluna body', exact: true })).toBeVisible()
})
test('SQL drafts survive navigation and refresh, files preview and uploads complete', async ({ page }) => {
  await page.goto('/admin/sql')
  await page.getByRole('textbox', { name: 'Editor SQL', exact: true }).waitFor()
  await draftsAndFiles(page)
})
test('the SQL editor runs a selection and underlines where it failed', async ({ page }) => {
  const query = 'select 1;' + String.fromCharCode(10) + 'select * from notess;'
  let sent = ''
  await page.route('**/admin/api/sql', async route => {
    sent = route.request().postDataJSON().sql
    // Postgres counts from 1 within the text it received.
    await route.fulfill({ json: { error: { message: 'relation "notess" does not exist', code: '42P01', detail: null, hint: null, position: sent.indexOf('notess') + 1 } } })
  })
  await page.goto('/admin/sql')
  const editor = page.getByRole('textbox', { name: 'Editor SQL', exact: true })
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(query)
  await page.keyboard.press('Shift+Home')
  await page.getByRole('button', { name: 'Executar seleção' }).click()
  await expect(page.locator('.cm-sql-error')).toHaveText('notess')
  expect(sent).toBe('select * from notess;')
  await expect(page.getByText('Destacado no editor, linha 2.')).toBeVisible()
  // Editing clears the mark: it described the text that ran.
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' ')
  await expect(page.locator('.cm-sql-error')).toHaveCount(0)
})
test('the SQL editor runs as a visitor or a chosen user', async ({ page }) => {
  const sent: unknown[] = []
  await page.route('**/admin/api/sql', async route => {
    sent.push(route.request().postDataJSON().run_as)
    await route.fulfill({ json: { results: [], results_truncated: false } })
  })
  await page.goto('/admin/sql')
  await page.getByRole('textbox', { name: 'Editor SQL', exact: true }).waitFor()
  const run = page.getByRole('button', { name: 'Executar', exact: true })
  await run.click()
  await page.getByRole('button', { name: /^Executar como: Dono do banco/ }).click()
  await page.getByRole('menuitem', { name: /Visitante/ }).click()
  await run.click()
  await page.getByRole('button', { name: /^Executar como: Visitante/ }).click()
  await page.getByRole('menuitem', { name: /Usuário logado/ }).click()
  await page.getByRole('option', { name: /bruno@example.test/ }).first().click()
  await expect(page.getByRole('button', { name: /^Executar como: bruno@example.test/ })).toBeVisible()
  await run.click()
  await expect.poll(() => sent.length).toBe(3)
  expect(sent[0]).toEqual({ role: 'owner' })
  expect(sent[1]).toEqual({ role: 'anon' })
  expect(sent[2]).toMatchObject({ role: 'authenticated' })
})
test('upload conflicts keep their original destination and SQL cells show full content', async ({ page }) => { await uploadsAndDetails(page) })
test('an incompatible API response can be retried without losing the page', async ({ page }) => {
  let failed = true
  await page.route('**/admin/api/users?*', async route => {
    if (failed) return route.fulfill({ json: { users: 'incompatible' } })
    return route.fulfill({ json: { page: 0, users: [], total: 0, has_next: false } })
  })
  await page.goto('/admin/users')
  await expect(page.getByRole('alert')).toContainText('resposta incompatível')
  failed = false
  await page.getByRole('button', { name: 'Tentar de novo', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
