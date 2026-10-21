import { test, expect, type Page } from '@playwright/test'
const id = 'a'.repeat(64)
const planId = 'b'.repeat(64)
const status = { email: 'operator@example.test', projects: [{ name: 'shop', version: '0.4.0', update_available: true }], jobs: [] as object[], release: { version: '0.5.0' }, enabled: true, checking: false, check_error: null }
const job = { id, project: 'shop', current: '0.4.0', target: '0.5.0', phase: 'preparing', sequence: 1, updated_at: 123, committed: false, error: null }
async function controller(page: Page) {
  await page.route('**/admin/', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="nelcota-updates-controller" content="1">') })
  })
}
test('an invalid host_busy response is rejected and reconnect accepts a boolean', async ({ page }) => {
  await controller(page)
  let compatible = false
  await page.route('**/admin/api/updates', route => route.fulfill({ json: {
    result: 'status', data: { ...status, host_busy: compatible ? false : 'false' },
  } }))
  await page.goto('/admin/')
  await expect(page.getByRole('button', { name: 'Reconectar', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preparar atualização' })).toHaveCount(0)
  compatible = true
  await page.getByRole('button', { name: 'Reconectar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Preparar atualização' })).toBeEnabled()
})
test('controller skips project SSO and uses its own operator login', async ({ page }) => {
  await controller(page)
  const projectRequests: string[] = []
  page.on('request', request => { if (/\/admin\/api\/(session|sso|whoami)$/.test(new URL(request.url()).pathname)) projectRequests.push(request.url()) })
  let signedIn = false
  await page.route('**/admin/api/updates', async route => {
    const request = route.request()
    if (request.method() === 'POST') {
      expect(request.headers()['x-nelcota-updates']).toBe('1')
      expect(request.postDataJSON()).toEqual({ action: 'login', email: 'operator@example.test', password: 'operator-test-password' })
      signedIn = true
      await route.fulfill({ json: { result: 'session', email: status.email } }); return
    }
    if (!signedIn) { await route.fulfill({ status: 401, json: { result: 'error', code: 'session_required' } }); return }
    await route.fulfill({ json: { result: 'status', data: status } })
  })
  await page.goto('/admin/#project-sso-token')
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill('operator@example.test')
  await page.getByLabel('Senha', { exact: true }).fill('operator-test-password')
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Preparar atualização' })).toBeVisible()
  expect(projectRequests).toEqual([])
})
test('lost start response is reconciled without automatically retrying a mutation', async ({ page }) => {
  await controller(page)
  let accepted = false
  const starts: { key: string; plan: string; password: string }[] = []
  await page.route('**/admin/api/updates', async route => {
    const request = route.request()
    if (request.method() === 'GET') { await route.fulfill({ json: { result: 'status', data: { ...status, jobs: accepted ? [job] : [] } } }); return }
    const body = request.postDataJSON()
    if (body.action === 'plan') { await route.fulfill({ json: { result: 'plan', data: { id: planId, project: 'shop', current: '0.4.0', target: '0.5.0', digest: id, expires_at: Math.floor(Date.now() / 1000) + 300, blockers: [] } } }); return }
    expect(body.action).toBe('start'); starts.push(body); accepted = true
    if (starts.length === 1) { await route.abort('connectionreset'); return }
    await route.fulfill({ json: { result: 'job', data: job } })
  })
  await page.goto('/admin/')
  await page.getByRole('button', { name: 'Preparar atualização' }).click()
  await page.getByLabel('Confirme a senha do operador').fill('operator-test-password')
  await page.getByRole('button', { name: 'Iniciar atualização', exact: true }).click()
  await expect(page.getByText('Preparando artefatos', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Confirme a senha do operador')).toHaveValue('')
  expect(starts).toHaveLength(1)
  await page.getByLabel('Confirme a senha do operador').fill('operator-test-password')
  await page.getByRole('button', { name: 'Iniciar atualização', exact: true }).click()
  await expect(page.getByLabel('Confirme a senha do operador')).toHaveCount(0)
  expect(starts).toHaveLength(2); expect(starts[0].key).toMatch(/^[a-f0-9]{64}$/); expect(starts[0].key).toBe(starts[1].key)
  await page.reload(); await expect(page.getByText('Preparando artefatos', { exact: true })).toBeVisible()
})
test('login resumes status polling after logout overtakes an older poll', async ({ page }) => {
  await controller(page)
  let reads = 0
  let started!: () => void
  let release!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/admin/api/updates', async route => {
    const request = route.request()
    if (request.method() === 'GET') {
      reads++
      if (reads === 2) {
        started()
        await held
        await route.fulfill({ status: 401, json: { result: 'error', code: 'session_expired' } }).catch(() => {})
        return
      }
      await route.fulfill({ json: { result: 'status', data: status } })
      return
    }
    const action = request.postDataJSON().action
    expect(['login', 'logout']).toContain(action)
    await route.fulfill({ json: action === 'login' ? { result: 'session', email: status.email } : { result: 'done' } })
  })
  try {
    await page.goto('/admin/')
    await expect(page.getByRole('button', { name: 'Preparar atualização' })).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await pending
    await page.getByRole('button', { name: 'Sair', exact: true }).click()
    await page.getByLabel('Email', { exact: true }).fill('operator@example.test')
    await page.getByLabel('Senha', { exact: true }).fill('operator-test-password')
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toHaveCount(0)
    release()
    await expect(page.getByRole('button', { name: 'Preparar atualização' })).toBeVisible()
    expect(reads).toBeGreaterThanOrEqual(3)
  } finally { release() }
})

test('committed incident recovery requires password and preserves the data boundary after reload', async ({ page }) => {
  await controller(page)
  const incident = { ...job, phase: 'needs_operator', sequence: 8, committed: true, error: 'worker_interrupted' }
  let recoveries = 0
  await page.route('**/admin/api/updates', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { result: 'status', data: { ...status, jobs: [incident] } } }); return }
    expect(route.request().postDataJSON()).toEqual({ action: 'recover', job: id, password: 'operator-test-password' }); recoveries++
    await route.fulfill({ json: { result: 'job', data: { ...incident, phase: 'committing', sequence: 9 } } })
  })
  await page.goto('/admin/'); await page.reload()
  await page.getByRole('button', { name: 'Recuperar operação', exact: true }).click()
  await expect(page.getByText('O tráfego já pode ter recebido gravações. A recuperação preservará os dados atuais.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Recuperar operação', exact: true }).first()).toBeDisabled()
  await page.getByLabel('Confirme a senha do operador').fill('operator-test-password')
  await page.getByRole('button', { name: 'Recuperar operação', exact: true }).first().click()
  await expect.poll(() => recoveries).toBe(1)
})

test('an expired online poll cannot replace a newly authenticated session', async ({ page }) => {
  await controller(page)
  let reads = 0
  let started!: () => void
  let release!: () => void
  const pending = new Promise<void>(resolve => { started = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/admin/api/updates', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON().action).toBe('login')
      await route.fulfill({ json: { result: 'session', email: status.email } })
      return
    }
    const current = ++reads
    if (current === 2) {
      started()
      await held
      await route.fulfill({ status: 401, body: '<html>Expired</html>' }).catch(() => {})
      return
    }
    if (current === 1) {
      await route.fulfill({ status: 401, body: '<html>Expired</html>' })
      return
    }
    await route.fulfill({ json: { result: 'status', data: status } })
  })
  try {
    await page.goto('/admin/')
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await pending
    await page.getByLabel('Email', { exact: true }).fill('operator@example.test')
    await page.getByLabel('Senha', { exact: true }).fill('operator-test-password')
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Preparar atualização' })).toBeVisible()
    release()
    await expect(page.getByRole('button', { name: 'Preparar atualização' })).toBeVisible()
    expect(reads).toBeGreaterThanOrEqual(3)
  } finally { release() }
})
