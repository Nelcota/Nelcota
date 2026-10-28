import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

test.beforeEach(async ({ page, context }) => {
  await fixture(page)
  await page.route('**/health', r => r.fulfill({ json: { status: 'ok' } }))
  await page.route('**/admin/api/typescript', r => r.fulfill({ headers: { 'x-nelcota-migration-version': '2' }, contentType: 'text/plain', body: 'export type Database = { public: { Tables: { notes: { Row: { id: number } } } } }\n' }))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
})

test('copies and downloads an AI context with this project, its address and schema', async ({ page }) => {
  await page.goto('/admin/connect?section=api-ai')
  const section = page.locator('#api-ai')
  const copy = section.getByRole('button', { name: 'Copiar contexto' })
  await expect(copy).toBeEnabled()
  await copy.click()
  await expect(page.getByText('Contexto copiado. Cole na conversa com a IA.')).toBeVisible()
  const text = await page.evaluate(() => navigator.clipboard.readText())
  const origin = new URL(page.url()).origin
  expect(text).toMatch(/^# nelcota-demo: Nelcota backend/)
  expect(text).toContain(`createClient<Database>('${origin}')`)
  expect(text).toContain('notes: { Row: { id: number } }')
  expect(text).toContain('- `owner_access`: ALL for authenticated')
  expect(text).not.toContain('service_role token:')

  await section.getByText(/Ver o texto/).click()
  await expect(section.locator('pre')).toContainText('## Database schema')

  const download = page.waitForEvent('download')
  await section.getByRole('button', { name: 'Baixar llms.txt' }).click()
  expect((await download).suggestedFilename()).toBe('llms.txt')
})

test('reports a failed build with a retry instead of an empty copy', async ({ page }) => {
  await page.route('**/admin/api/typescript', r => r.fulfill({ status: 503, body: 'unavailable' }))
  await page.goto('/admin/connect?section=api-ai')
  const section = page.locator('#api-ai')
  await expect(section.getByText(/Não foi possível montar o contexto/)).toBeVisible()
  await expect(section.getByRole('button', { name: 'Copiar contexto' })).toHaveCount(0)
})

test('refuses context generation when the schema snapshot has no migration version', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nelcota.locale', 'en'))
  await page.route('**/admin/api/typescript', route => route.fulfill({ contentType: 'text/plain', body: 'export type Database = {}' }))
  await page.goto('/admin/connect?section=api-ai')
  const section = page.locator('#api-ai')
  await expect(section.getByRole('alert')).toContainText('Could not verify the current migration version')
  await expect(section.getByRole('button', { name: 'Copy context', exact: true })).toHaveCount(0)
  await expect(section.getByRole('button', { name: 'Download llms.txt', exact: true })).toHaveCount(0)
})
