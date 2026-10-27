import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

function result(rows: number, columns: number, tag: string) {
  return {
    columns: Array.from({ length: columns }, (_, c) => `column_${c}`),
    rows: Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => (c === 1 && r % 2 === 0 ? `${tag}-${r}-long ${'x'.repeat(120)}` : `${tag}-${r}-${c}`))),
    count: rows,
    truncated: false,
  }
}

test.beforeEach(async ({ page }) => { await fixture(page) })

test('large SQL results render only the rows in view and keep their layout while scrolling', async ({ page }) => {
  await page.route('**/admin/api/sql', route => route.fulfill({ json: { results: [result(1000, 30, 'first'), result(1000, 12, 'second')], results_truncated: true } }))
  await page.goto('/admin/sql')
  await page.getByRole('textbox', { name: 'Editor SQL', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Executar', exact: true }).click()
  const region = page.getByRole('region', { name: 'Resultados da consulta SQL' })
  await expect(region.getByText('first-0-0', { exact: true })).toBeVisible()

  const first = region.locator('table').first()
  await expect(first).toHaveAttribute('aria-rowcount', '1001')
  expect(await first.locator('tbody tr[data-index]').count()).toBeLessThan(100)
  const widths = () => first.locator('thead th').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().width)))
  const before = await widths()

  // Middle of the first result: the header stays on top and the rows are contiguous.
  await region.evaluate(element => { element.scrollTop = 500 * 33 })
  await expect(region.getByText('first-500-0', { exact: true })).toBeVisible()
  const header = first.locator('thead th').first()
  const regionBox = await region.boundingBox()
  const headerBox = await header.boundingBox()
  expect(Math.abs((headerBox?.y ?? 0) - (regionBox?.y ?? -100))).toBeLessThan(2)
  const indexes = await first.locator('tbody tr[data-index]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-index'))))
  expect(indexes.every((index, position) => position === 0 || index === indexes[position - 1] + 1)).toBe(true)
  expect(await widths()).toEqual(before)

  // The end of the first result and the second result follow in order.
  await region.evaluate(element => { element.scrollTop = 0 })
  await region.focus()
  await page.keyboard.press('End')
  await expect(region.getByText('second-999-0', { exact: true })).toBeVisible()
  await region.locator('table').nth(1).evaluate(table => table.scrollIntoView())
  await expect(region.getByText('second-0-0', { exact: true })).toBeVisible()

  // Long values still open their full text.
  await region.evaluate(element => { element.scrollTop = 0 })
  await region.getByRole('button', { name: 'Ver conteúdo completo' }).first().click()
  await expect(page.getByRole('dialog')).toContainText(`first-0-long ${'x'.repeat(120)}`)
})

test('small SQL results keep every row in the page for find and selection', async ({ page }) => {
  await page.route('**/admin/api/sql', route => route.fulfill({ json: { results: [result(150, 4, 'small')], results_truncated: false } }))
  await page.goto('/admin/sql')
  await page.getByRole('textbox', { name: 'Editor SQL', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Executar', exact: true }).click()
  const region = page.getByRole('region', { name: 'Resultados da consulta SQL' })
  await expect(region.getByText('small-0-0', { exact: true })).toBeVisible()
  await expect(region.locator('tbody tr[data-index]')).toHaveCount(150)
  await expect(region.getByText('small-149-3', { exact: true })).toBeAttached()
})

test('focus leaves an unmounted details button for the results pane', async ({ page }) => {
  await page.route('**/admin/api/sql', route => route.fulfill({ json: { results: [result(1000, 4, 'focus')], results_truncated: false } }))
  await page.goto('/admin/sql')
  await page.getByRole('textbox', { name: 'Editor SQL', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Executar', exact: true }).click()
  const region = page.getByRole('region', { name: 'Resultados da consulta SQL' })
  const details = region.getByRole('button', { name: 'Ver conteúdo completo' }).first()
  await details.focus()
  await expect(details).toBeFocused()
  await region.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(region.getByText('focus-999-0', { exact: true })).toBeVisible()
  await expect(region).toBeFocused()
})

test('a larger root font keeps rows aligned and End reaches the last row', async ({ page }) => {
  await page.route('**/admin/api/sql', route => route.fulfill({ json: { results: [result(1000, 6, 'large')], results_truncated: false } }))
  await page.goto('/admin/sql')
  await page.addStyleTag({ content: 'html { font-size: 20px }' })
  await page.getByRole('textbox', { name: 'Editor SQL', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Executar', exact: true }).click()
  const region = page.getByRole('region', { name: 'Resultados da consulta SQL' })
  await expect(region.getByText('large-0-0', { exact: true })).toBeVisible()
  const height = await region.locator('tbody tr[data-index]').first().evaluate(row => row.getBoundingClientRect().height)
  expect(height).toBe(41)
  await region.focus()
  await page.keyboard.press('End')
  await expect(region.getByText('large-999-0', { exact: true })).toBeVisible()
})
