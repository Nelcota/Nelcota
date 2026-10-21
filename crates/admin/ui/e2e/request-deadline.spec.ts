import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

test('a stalled write releases its form and warns before any manual retry', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nelcota.locale', 'en'))
  await fixture(page)
  await page.route('**/health', route => route.fulfill({ json: { status: 'ok' } }))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  await page.route('**/admin/api/users', async route => {
    writes++
    await held
    await route.fulfill({ json: { id: '00000000-0000-4000-8000-000000000099', email: 'deadline@example.test' } }).catch(() => {})
  })
  try {
    await page.goto('/admin/users')
    await page.getByRole('button', { name: 'New user', exact: true }).first().click()
    await page.locator('#new-user-email').fill('deadline@example.test')
    await page.locator('#new-user-password').fill('A sufficiently long password 42!')
    await page.clock.install()
    const sent = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/admin/api/users')
    await page.getByRole('dialog').locator('button[type="submit"]').click()
    await sent
    await page.clock.fastForward(60_001)
    await expect(page.getByRole('dialog')).toContainText('Could not confirm the request result. Refresh the data before trying again.')
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
    await expect(page.locator('#new-user-email')).toHaveValue('deadline@example.test')
    await page.clock.fastForward(120_000)
    expect(writes).toBe(1)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally { release() }
})
