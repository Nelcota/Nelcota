import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

test('private modules load only after login, including on a deep link', async ({ page }) => {
  await fixture(page)
  await page.route('**/admin/api/session', route => route.fulfill({ status: 401, json: { code: 'session_expired', message: 'Sign in' } }))
  await page.route('**/admin/api/login', route => route.fulfill({ json: { email: 'admin@example.test' } }))
  const modules: string[] = []
  page.on('request', request => modules.push(request.url()))
  const identity = page.waitForResponse(response => new URL(response.url()).pathname === '/admin/api/whoami')
  await page.goto('/admin/storage/documents')
  await expect(page.getByRole('heading', { name: 'Entrar no Nelcota' })).toBeVisible()
  await (await identity).finished()
  // Lists the offending URLs, so an intermittent CI failure says what loaded.
  expect(modules.filter(url => /AuthenticatedShell|(?:TableEditor|StorageBucket|CodeBlock|SqlEditor)(?:\.svelte|-)/.test(url))).toEqual([])
  await page.getByLabel('Email', { exact: true }).fill('admin@example.test')
  await page.getByLabel('Senha', { exact: true }).fill('test-password')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('documents')
  expect(modules.some(url => url.includes('AuthenticatedShell'))).toBe(true)
  expect(modules.some(url => /StorageBucket(?:\.svelte|-)/.test(url))).toBe(true)
})
