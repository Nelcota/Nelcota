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
      // Busy on the step list, not on <main>, so the step changes inside it are announced.
      if (state === 'loading') await expect(main).not.toHaveAttribute('aria-busy')
      if (state === 'loading') await expect(page.getByRole('list', { name: 'Etapas do carregamento' })).toHaveAttribute('aria-busy', 'true')
      if (state === 'offline') await expect(page.getByRole('alert')).toBeVisible()
      // Offline keeps the login's header; loading has the mark at its centre.
      await expect(page.locator('img[src*="nelcota-"]:visible')).toHaveCount(1)
      await expect(page.locator(`${state === 'loading' ? 'main' : 'header'} img[src*="nelcota-"]:visible`)).toHaveCount(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    } finally { release() }
  })
}

test('the loading indicator waits before showing, so a fast start does not flash it', async ({ page }) => {
  await fixture(page)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/admin/api/session', async route => {
    await held
    await route.fulfill({ status: 401, json: { code: 'session_expired' } }).catch(() => {})
  })
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    const indicator = page.locator('.loading-screen-indicator')
    await expect(indicator).toBeAttached()
    expect(Number(await indicator.evaluate(el => getComputedStyle(el).opacity))).toBeLessThan(0.1)
    await expect.poll(() => indicator.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1)
  } finally { release() }
})

test('the startup screen walks through its steps without starting over', async ({ page }) => {
  await fixture(page)
  let releaseSession!: () => void
  const session = new Promise<void>(resolve => { releaseSession = resolve })
  let releaseShell!: () => void
  const shell = new Promise<void>(resolve => { releaseShell = resolve })
  await page.route('**/admin/api/session', async route => {
    await session
    await route.fulfill({ json: { email: 'admin@example.test' } }).catch(() => {})
  })
  await page.route('**/AuthenticatedShell.svelte*', async route => {
    await shell
    await route.continue().catch(() => {})
  })
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    const steps = page.getByRole('list', { name: 'Etapas do carregamento' }).getByRole('listitem')
    await expect(page.getByRole('heading', { name: 'Conectando ao servidor' })).toBeVisible()
    await expect(steps.nth(0)).toContainText('(em andamento)')
    await expect(steps.nth(1)).toContainText('(a seguir)')
    // Fully shown before the next step, to see it is not faded in again.
    await expect.poll(() => page.locator('.loading-screen-indicator').evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1)

    releaseSession()
    await expect(page.getByRole('heading', { name: 'Abrindo o painel' })).toBeVisible()
    await expect(steps.nth(0)).toContainText('(concluído)')
    await expect(steps.nth(1)).toContainText('(em andamento)')
    expect(Number(await page.locator('.loading-screen-indicator').evaluate(el => getComputedStyle(el).opacity))).toBe(1)

    releaseShell()
    await expect(page.getByRole('heading', { name: 'Visão geral', exact: true })).toBeVisible()
    await expect(page.locator('.loading-screen-indicator')).toHaveCount(0)
  } finally { releaseSession(); releaseShell() }
})

test('a long start explains the wait', async ({ page }) => {
  await page.clock.install()
  await fixture(page)
  await page.route('**/admin/api/session', () => {})
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Conectando ao servidor' })).toBeAttached()
  await expect(page.getByText('Está demorando mais que o normal')).toHaveCount(0)
  await page.clock.runFor(8000)
  await expect(page.getByText('Está demorando mais que o normal')).toBeVisible()
})

for (const [stored, prefersLight, dark] of [['light', false, false], ['dark', true, true], ['system', true, false], [null, true, true]] as const) {
  test(`theme ${stored ?? 'unset'} is applied before the app runs (system ${prefersLight ? 'light' : 'dark'})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: prefersLight ? 'light' : 'dark' })
    if (stored) await page.addInitScript(value => localStorage.setItem('mode-watcher-mode', value), stored)
    // Without the app bundle, only the <head> script can have set the theme.
    await page.route('**/src/main.ts*', route => route.abort())
    await page.goto('/admin/', { waitUntil: 'domcontentloaded' })
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(dark)
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe(dark ? 'dark' : 'light')
  })
}
