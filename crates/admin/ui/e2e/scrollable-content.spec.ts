import { expect, test } from '@playwright/test'
import { fixture } from './fixtures'

test('keyboard users can reach and scroll read-only migration history', async ({ page }) => {
  await fixture(page)
  await page.route('**/health', route => route.fulfill({ json: { status: 'ok' } }))
  await page.setViewportSize({ width: 320, height: 650 })
  await page.route('**/admin/api/migrations', route => route.fulfill({ json: {
    migrations: Array.from({ length: 40 }, (_, index) => ({
      version: index + 1, name: `change_${index}`, applied_on: '2026-10-08T10:30:00Z',
      in_folder: true, from_panel: false,
    })),
    pending: [], next_version: 41, folder: '/app/migrations',
  } }))
  await page.goto('/admin/migrations')
  await expect(page.getByText('V40 · change_39', { exact: true })).toBeAttached()
  const content = page.getByRole('main')
  expect(await content.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  let reached = false
  for (let step = 0; step < 30; step++) {
    await page.keyboard.press('Tab')
    if (await content.evaluate(element => element === document.activeElement)) {
      reached = true
      break
    }
  }
  expect(reached, 'Read-only content must be reachable in sequential keyboard navigation').toBe(true)
  expect(await content.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none')
  const before = await content.evaluate(element => element.scrollTop)
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(before)
})
