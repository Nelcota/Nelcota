import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

const stamp = '2026-10-01T12:00:00Z'
const user = (i: number) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `pessoa${i}@example.test`, created_at: stamp, last_sign_in_at: null, email_confirmed_at: stamp, sessions: 0, has_password: true, providers: [] })

test('a page past the end moves to the last page instead of reading "no users"', async ({ page }) => {
  await fixture(page)
  // 60 users at 50 per page: pages 0 and 1 exist, the server echoes the requested page.
  await page.route('**/admin/api/users?*', route => {
    const requested = Number(new URL(route.request().url()).searchParams.get('page') ?? 0)
    const users = requested === 0 ? Array.from({ length: 50 }, (_, i) => user(i)) : requested === 1 ? Array.from({ length: 10 }, (_, i) => user(50 + i)) : []
    return route.fulfill({ json: { page: requested, users, total: 60, has_next: requested === 0 } })
  })
  await page.goto('/admin/users?page=3')
  await expect(page).toHaveURL(/\/users\?page=1$/)
  // The list renders twice (table and phone cards); one of them is visible.
  await expect(page.getByText('pessoa59@example.test', { exact: true }).filter({ visible: true })).toHaveCount(1)
  await expect(page.getByText('Nenhum usuário', { exact: true })).toHaveCount(0)
})
