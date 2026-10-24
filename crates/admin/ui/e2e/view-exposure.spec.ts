import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

test('owner views warn and explain invoker privileges without offering table policies', async ({ page }) => {
  await fixture(page)
  const protectedRls = { state: 'ok', label: 'RLS · 1 policies', enabled: true, forced: false, policies: 1 }
  const ownerRls = { state: 'danger', label: 'view owner privileges', enabled: false, forced: false, policies: 0 }
  const grants = { anon: ['SELECT'], authenticated: ['SELECT'] }
  await page.route('**/admin/api/overview', route => route.fulfill({ json: {
    schema: 'public', counts: { tables: 1, users: 0, signed_in_users: 0, policies: 1, functions: 0 },
    exposed_without_rls: ['owner_todos'],
    tables: [
      { name: 'todos', kind: 'table', comment: null, rows: 2, rows_exact: true, rls: protectedRls, grants },
      { name: 'owner_todos', kind: 'view', comment: null, rows: null, rows_exact: false, rls: ownerRls, grants },
    ],
  } }))
  await page.route('**/admin/api/policies', route => route.fulfill({ json: {
    schema: 'public', exposed_without_rls: ['owner_todos'], anon_functions: [],
    tables: [{ name: 'todos', rls: protectedRls, exposed_without_rls: false, policies: [] }],
  } }))
  await page.goto('/admin/')
  await expect(page.getByText('Acesso sem proteção por usuário em owner_todos')).toBeVisible()
  await page.goto('/admin/policies')
  await expect(page.getByText('Acesso sem proteção por usuário: owner_todos')).toBeVisible()
  await expect(page.getByText(/Revise owner_todos no editor SQL/)).toBeVisible()
  await expect(page.getByText(/configure security_invoker = true/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Nova regra', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Ativar proteção por linha (RLS)', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Revisar acesso', exact: true }).click()
  await expect(page.getByText('Outros objetos precisam de revisão')).toBeVisible()
  await expect(page.getByText('Nada precisa de atenção')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Abrir editor SQL', exact: true })).toHaveAttribute('href', '/admin/sql')
})
