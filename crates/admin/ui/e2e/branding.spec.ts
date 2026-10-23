import { test, expect } from '@playwright/test'
import { fixture } from './fixtures'

for (const theme of ['light', 'dark']) {
  test(`official branding loads in ${theme} mode without mascot assets`, async ({ page }, info) => {
    const images: string[] = []
    page.on('request', request => { if (request.resourceType() === 'image') images.push(request.url()) })
    await page.addInitScript(value => localStorage.setItem('mode-watcher-mode', value), theme)
    await fixture(page)
    await page.route('**/admin/api/session', route => route.fulfill({ status: 401, json: { code: 'session_expired' } }))
    await page.goto('/admin/')
    await expect(page.getByRole('heading', { name: 'Entrar no Nelcota' })).toBeVisible()
    const color = theme === 'dark' ? 'white' : 'black'
    const logo = page.locator(`header img[src*="nelcota-logo-${color}"]`)
    await expect(logo).toBeVisible()
    await expect(logo).toHaveAttribute('alt', 'Nelcota')
    expect(await logo.evaluate(image => image.getBoundingClientRect().width)).toBeGreaterThanOrEqual(240)
    await expect.poll(() => logo.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /nelcota-symbol-blue.*\.svg/)
    await page.screenshot({ path: info.outputPath(`login-${theme}.png`), fullPage: true })
    await page.setViewportSize({ width: 320, height: 844 })
    await expect(page.locator(`header img[src*="nelcota-symbol-${color}"]`)).toBeVisible()
    const symbol = page.locator(`header img[src*="nelcota-symbol-${color}"]:visible`)
    expect(await symbol.evaluate(image => image.getBoundingClientRect().width)).toBeGreaterThanOrEqual(40)
    expect(await symbol.evaluate(image => Number.parseFloat(getComputedStyle(image.parentElement!).paddingLeft))).toBeGreaterThanOrEqual(10)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(images.some(url => /mascot|eyes-closed|neutral-|wave-|sad-/.test(url))).toBe(false)
  })
}

for (const theme of ['light', 'dark']) {
  test(`general panel uses one brand mark across project and error pages in ${theme}`, async ({ page }, info) => {
    const images: string[] = []
    page.on('request', request => { if (request.resourceType() === 'image') images.push(request.url()) })
    await page.addInitScript(value => localStorage.setItem('mode-watcher-mode', value), theme)
    await fixture(page)
    await page.route('**/health', route => route.fulfill({ json: { status: 'ok' } }))
    for (const [path, heading] of [['/admin/', 'Visão geral'], ['/admin/projects', 'Projetos'], ['/admin/page-does-not-exist', 'Página não encontrada']]) {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      await expect(page.locator('img[src*="nelcota-"]:visible')).toHaveCount(1)
      const mark = page.locator('.panel-rail img:visible')
      await expect.poll(() => mark.evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
      if (path === '/admin/') await page.screenshot({ path: info.outputPath(`general-panel-${theme}.png`), fullPage: true })
    }
    expect(images.some(url => /mascot|eyes-closed|neutral-|wave-|sad-/.test(url))).toBe(false)
  })
}

for (const state of ['loading', 'offline']) {
  test(`standalone ${state} branding fits a small phone`, async ({ page }) => {
    await fixture(page)
    await page.setViewportSize({ width: 320, height: 844 })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route('**/admin/api/session', async route => {
      if (state === 'loading') await held
      await route.fulfill({ status: 503, json: { message: 'Temporarily unavailable' } }).catch(() => {})
    })
    try {
      await page.reload({ waitUntil: 'domcontentloaded' })
      const main = page.getByRole('main')
      if (state === 'loading') await expect(main).toHaveAttribute('aria-busy', 'true')
      if (state === 'offline') await expect(page.getByRole('alert')).toBeVisible()
      await expect(main.locator('img[src*="nelcota-"]:visible')).toHaveCount(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    } finally { release() }
  })
}
