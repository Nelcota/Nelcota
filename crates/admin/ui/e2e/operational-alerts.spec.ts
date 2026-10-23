import { test, expect, type Page } from '@playwright/test'
const id = 'a'.repeat(64), digest = 'b'.repeat(64)
const settings = { enabled: true, email_enabled: false, webhook_enabled: true, heartbeat_enabled: false, smtp_project: '', recipient: '', disk_percent: 15, disk_gib: 3, certificate_days: 14, backup_hours: 26, reminder_hours: 24 }
const alerts = { settings, recipients: ['operator@example.test'], projects: ['base'], webhook_configured: true, heartbeat_configured: false, webhook_host: 'notify.example.test', heartbeat_host: null, last_scan_at: null, heartbeat_accepted_at: null, heartbeat_error: null, monitor_error: null, maintenance: false, incidents: [], channels: [] }
async function mount(page: Page, actions: Record<string, unknown>[], options: { unavailable?: boolean; status?: { monitor_error?: string | null; last_scan_at?: number | null } } = {}) {
  await page.route('**/admin/', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="nelcota-updates-controller" content="1">') })
  })
  await page.route('**/admin/api/updates', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { result: 'status', data: { email: 'operator@example.test', host_management: true, projects: [{ name: 'base', version: '0.5.1', update_available: false }], jobs: [], release: null, enabled: false, checking: false, check_error: null } } }); return
    }
    const body = route.request().postDataJSON() as Record<string, unknown>; actions.push(body)
    switch (body.action) {
      case 'host_status': await route.fulfill({ json: { result: 'host_status', data: { receipt: null, enabled: true, projects: [{ name: 'base', domain: 'base.example.test', version: '0.5.1', app: 'healthy', database: 'healthy', backups: [] }], jobs: [], max_projects: 5, ram_mb: 8192, free_bytes: 90 * 1024 ** 3 } } }); return
      case 'host_alerts':
        if (options.unavailable) { await route.fulfill({ status: 503, json: { error: 'unavailable' } }); return }
        await route.fulfill({ json: { result: 'host_alerts', data: { ...alerts, ...options.status } } }); return
      case 'host_configure_plan': case 'host_plan': {
        const operation = body.action === 'host_configure_plan' ? { kind: 'configure', project: 'base', section: 'alerts', revision: 'c'.repeat(64) } : body.operation as { kind: string }
        await route.fulfill({ json: { result: 'host_plan', data: { id, operation, confirmation: `${operation.kind.toUpperCase()} base`, affected_projects: ['base', 'second-project'], blockers: [], expires_at: Math.floor(Date.now() / 1000) + 300, version: '0.5.1', image_digest: digest, ram_mb: 8192, free_bytes: 90 * 1024 ** 3, project_count: 1, destructive: false } } }); return
      }
      case 'host_start': await route.abort('failed'); return
      default: throw new Error(`Unexpected action: ${String(body.action)}`)
    }
  })
  await page.goto('/admin/')
  await page.getByRole('button', { name: 'Alertas', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Alertas', exact: true })).toBeVisible()
  if (!options.unavailable) await expect(page.getByText('notify.example.test', { exact: false })).toBeVisible()
}
test('alerts explain external observation, stay read-only and fit mobile', async ({ page }, info) => {
  const actions: Record<string, unknown>[] = []; await mount(page, actions)
  await expect(page.getByText('Queda total da VPS exige um observador externo')).toBeVisible()
  await expect(page.getByText('Aguardando uma verificação recente do worker')).toBeVisible()
  expect(actions.filter(a => ['host_plan', 'host_configure_plan', 'host_start'].includes(String(a.action)))).toHaveLength(0)
  await page.screenshot({ path: info.outputPath('alerts-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: info.outputPath('alerts-mobile.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
test('private URLs clear after review and execution needs explicit approval', async ({ page }) => {
  const actions: Record<string, unknown>[] = []; await mount(page, actions)
  await page.getByLabel('Nova URL privada do webhook', { exact: true }).fill('https://notify.example.test/private-alert-token')
  await expect(page.getByRole('button', { name: 'Testar envio de alertas', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Validar e revisar alertas', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Revise antes de confirmar' })).toBeVisible()
  await expect(page.getByText('base, second-project', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Nova URL privada do webhook', { exact: true })).toHaveValue('')
  expect(actions.filter(a => a.action === 'host_start')).toHaveLength(0)
  await page.getByLabel('Conferi o projeto, o domínio e o impacto desta operação.').check()
  await page.getByLabel('Tenho acesso SSH e compreendo como recuperar a VPS.').check()
  await page.getByLabel('Digite exatamente a confirmação abaixo').fill('CONFIGURE base')
  await page.getByLabel('Confirme a senha do operador').fill('operator-test-password')
  await page.getByRole('button', { name: 'Confirmar e executar', exact: true }).click()
  await expect.poll(async () => page.evaluate(() => sessionStorage.getItem('nelcota.host.request:operator@example.test'))).not.toBeNull()
  const stored = await page.evaluate(() => JSON.stringify([sessionStorage, localStorage]))
  expect(stored).not.toContain('private-alert-token'); expect(stored).not.toContain('operator-test-password')
  expect(JSON.stringify(actions.find(a => a.action === 'host_start'))).not.toContain('private-alert-token')
})
test('drafts require discard and delivery tests prepare a host-wide plan', async ({ page }) => {
  const actions: Record<string, unknown>[] = []; await mount(page, actions)
  await page.getByLabel('Avisar abaixo de espaço livre (%)', { exact: true }).fill('20')
  await page.getByRole('button', { name: 'Saúde', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  expect(actions.some(a => a.action === 'host_start')).toBe(false)
  await page.reload()
  await page.getByRole('button', { name: 'Alertas', exact: true }).click()
  await page.getByRole('button', { name: 'Testar envio de alertas', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Revise antes de confirmar' })).toBeVisible()
  expect(actions.some(a => a.action === 'host_plan' && (a.operation as { kind: string }).kind === 'test_alerts')).toBe(true)
  expect(actions.some(a => a.action === 'host_start')).toBe(false)
})

test('failed initial status stops announcing loading and offers retry', async ({ page }) => {
  await mount(page, [], { unavailable: true })
  await expect(page.getByText('Não foi possível consultar o monitor. Verifique a conexão e tente novamente.')).toBeVisible()
  await expect(page.getByText('Consultando monitor…', { exact: true })).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Recarregar configuração', exact: true })).toBeEnabled()
})
test('persistent monitor errors take priority over waiting for a first scan', async ({ page }) => {
  await mount(page, [], { status: { monitor_error: 'alert_state_unavailable', last_scan_at: null } })
  await expect(page.getByText('Há verificações indisponíveis; consulte os incidentes')).toBeVisible()
  await expect(page.getByText('O estado persistido dos alertas está indisponível.', { exact: false })).toBeVisible()
  await expect(page.getByText('Aguardando uma verificação recente do worker')).not.toBeVisible()
})

async function pollingClock(page: Page) {
  await page.clock.install({ time: new Date('2026-10-23T02:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-23T02:00:01Z'))
}
async function pollingSeconds(page: Page, seconds: number) {
  for (let second = 0; second < seconds; second++) {
    await page.clock.runFor(1000)
    await page.waitForTimeout(10)
  }
}
test('visible polling keeps unsaved alert settings', async ({ page }) => {
  await pollingClock(page)
  const actions: Record<string, unknown>[] = []
  await mount(page, actions)
  await page.getByLabel('Avisar abaixo de espaço livre (%)', { exact: true }).fill('20')
  const before = actions.filter(a => a.action === 'host_alerts').length
  await pollingSeconds(page, 60)
  expect(actions.filter(a => a.action === 'host_alerts').length).toBeGreaterThan(before)
  await expect(page.getByLabel('Avisar abaixo de espaço livre (%)', { exact: true })).toHaveValue('20')
  expect(actions.some(a => a.action === 'host_start')).toBe(false)
})
test('leaving host management releases its pollers', async ({ page }) => {
  await pollingClock(page)
  const actions: Record<string, unknown>[] = []
  await mount(page, actions)
  await page.getByRole('button', { name: 'Atualizações', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Alertas', exact: true })).toHaveCount(0)
  const before = actions.length
  await pollingSeconds(page, 60)
  expect(actions).toHaveLength(before)
})

async function pollingVisibility(page: Page, hidden: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value ? 'hidden' : 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}
test('hidden controller pauses polling and resumes once without discarding drafts', async ({ page }) => {
  await pollingClock(page)
  const requests: string[] = []
  page.on('request', request => {
    if (!request.url().endsWith('/admin/api/updates')) return
    requests.push(request.method() === 'GET' ? 'updates' : String(request.postDataJSON().action))
  })
  await mount(page, [])
  await page.getByLabel('Avisar abaixo de espaço livre (%)', { exact: true }).fill('20')
  await page.waitForTimeout(100)
  await pollingVisibility(page, true)
  const before = requests.length
  await pollingSeconds(page, 120)
  expect(requests).toHaveLength(before)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => requests.slice(before).length).toBe(3)
  expect(requests.slice(before).sort()).toEqual(['host_alerts', 'host_status', 'updates'])
  await expect(page.getByLabel('Avisar abaixo de espaço livre (%)', { exact: true })).toHaveValue('20')
})
