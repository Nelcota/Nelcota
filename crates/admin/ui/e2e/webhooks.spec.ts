import { expect, test, type Page } from '@playwright/test'
import { fixture } from './fixtures'

const stamp = '2026-10-11T12:00:00Z'
const endpointId = '00000000-0000-4000-8000-000000000001'
const eventId = '00000000-0000-4000-8000-000000000002'
const secret = `whsec_${'a'.repeat(64)}`
const deliveryId = '9223372036854775800'
type Hook = { id: string; name: string; schema: string; table: string; table_available: boolean; url: string; events: string[]; enabled: boolean; max_attempts: number; created_at: string }
const initial: Hook = { id: endpointId, name: 'Pedidos pagos', schema: 'public', table: 'notes', table_available: true, url: 'https://example.com/hook', events: ['INSERT', 'UPDATE'], enabled: true, max_attempts: 6, created_at: stamp }

async function setup(page: Page, empty = false) {
  await fixture(page)
  let hooks: Hook[] = empty ? [] : [{ ...initial }]
  let resent = false
  const writes: { method: string; path: string; body: unknown }[] = []
  const historyQueries: string[] = []
  const delivery = () => ({ id: deliveryId, endpoint_id: endpointId, endpoint_name: initial.name, endpoint_enabled: hooks[0]?.enabled ?? false, event_id: eventId, replay_of: null, schema: 'public', table: 'notes', event: 'UPDATE', url: initial.url, status: 'failed', attempts: 2, max_attempts: 6, created_at: stamp, next_attempt_at: null, finished_at: stamp, last_status: 503, last_error: 'http_error' })
  await page.route('**/admin/api/webhooks**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/admin/api'.length)
    if (request.method() !== 'GET') writes.push({ method: request.method(), path, body: request.postDataJSON() })
    const reply = (json: unknown) => route.fulfill({ status: 200, json });
    if (path === '/webhooks' && request.method() === 'GET') return reply({ endpoints: hooks, tables: ['notes', 'orders'], allow_loopback: false, outstanding: resent ? 1 : 0, retained: resent ? 2 : 1 });
    if (path === '/webhooks' && request.method() === 'POST') {
      const input = request.postDataJSON() as Omit<Hook, 'id' | 'schema' | 'table_available' | 'created_at'>
      const endpoint = { ...initial, ...input }; hooks = [endpoint]; return reply({ endpoint, secret });
    }
    if (path === `/webhooks/${endpointId}` && request.method() === 'PUT') {
      hooks = [{ ...hooks[0], ...request.postDataJSON() }]; return reply(hooks[0]);
    }
    if (path === `/webhooks/${endpointId}` && request.method() === 'DELETE') {
      hooks = []; return route.fulfill({ status: 204 })
    }
    if (path === `/webhooks/${endpointId}/rotate`) return reply({ endpoint: hooks[0], secret });
    if (path === '/webhooks/deliveries' && request.method() === 'DELETE') return reply({ deleted: 1 });
    if (path === '/webhooks/deliveries') { historyQueries.push(url.search); return reply({ deliveries: [delivery()], next_cursor: url.searchParams.has('before') ? null : '50' }); }
    if (path === `/webhooks/deliveries/${deliveryId}/replay`) { resent = true; return reply({ id: '9223372036854775801' }); }
    if (path.startsWith('/webhooks/deliveries/')) {
      const replay = path.endsWith('5801')
      return reply({ delivery: replay ? { ...delivery(), id: '9223372036854775801', status: 'pending', attempts: 0, last_status: null, last_error: null, finished_at: null, next_attempt_at: stamp, replay_of: deliveryId } : delivery(), payload: JSON.stringify({ id: eventId, type: 'UPDATE', record: { title: '<script>window.webhookXss = true</script>' } }), attempts: replay ? [] : [{ number: 2, started_at: stamp, finished_at: stamp, status_code: 503, duration_ms: 25, error: 'http_error' }, { number: 1, started_at: stamp, finished_at: stamp, status_code: null, duration_ms: null, error: 'worker_interrupted' }] });
    }
    return route.fulfill({ status: 404, json: { code: 'webhook_not_found', error: 'Not found' } })
  })
  await page.goto('/admin/webhooks')
  return { writes, historyQueries }
}

test('create shows the key once, then edit/pause/rotate/delete remain usable', async ({ page }) => {
  const { writes } = await setup(page, true)
  await page.getByRole('button', { name: 'Novo webhook', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Nome', { exact: true }).fill('Notificar pedidos')
  await dialog.getByLabel('Tabela', { exact: true }).click()
  await page.getByRole('option', { name: 'orders', exact: true }).click()
  await dialog.getByLabel('URL de destino', { exact: true }).fill('https://example.com/orders')
  await dialog.getByRole('checkbox', { name: 'Linha atualizada', exact: true }).check()
  await dialog.getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Guarde a chave de assinatura' })).toBeVisible()
  await expect(page.getByText(secret, { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText(secret, { exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Já copiei a chave', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('ainda não copiou')
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar sem copiar', exact: true }).click()
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(secret)
  expect(writes[0].body).toMatchObject({ name: 'Notificar pedidos', table: 'orders', events: ['INSERT', 'UPDATE'], enabled: true, max_attempts: 6 })
  await page.getByRole('button', { name: 'Pausar', exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: 'Pausar Notificar pedidos?' })).toBeVisible()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Pausar webhook', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Ativar', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Ativar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Ações de Notificar pedidos', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Trocar chave', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Trocar chave', exact: true }).click()
  await expect(page.getByText(secret, { exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Já copiei a chave', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar sem copiar', exact: true }).click()
  await page.getByRole('button', { name: 'Ações de Notificar pedidos', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Apagar', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Apagar webhook', exact: true }).click()
  await expect(page.getByText('Conecte o banco aos seus serviços', { exact: true })).toBeVisible()
})

test('history filters and cursor survive URL navigation; resend preserves the event and opens the new delivery', async ({ page }) => {
  const { writes, historyQueries } = await setup(page)
  const history = page.locator('.panel-sidebar').getByRole('link', { name: 'Histórico de entregas', exact: true })
  await history.click()
  await expect(history).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'Novo webhook', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Ver entrega', exact: true })).toBeVisible()
  await page.getByLabel('Filtrar por webhook').click()
  await page.getByRole('option', { name: 'Pedidos pagos', exact: true }).click()
  await page.getByLabel('Filtrar por estado').click()
  await page.getByRole('option', { name: 'Falhou', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`endpoint=${endpointId}.*status=failed`))
  await page.getByRole('button', { name: 'Mais antigas' }).click()
  await expect(page).toHaveURL(/before=50/)
  await page.reload()
  await expect(page.getByLabel('Filtrar por estado')).toHaveText('Falhou')
  await expect(page.getByLabel('Filtrar por webhook')).toHaveText('Pedidos pagos')
  expect(historyQueries.some(query => query.includes('before=50') && query.includes('status=failed'))).toBe(true)
  await page.getByRole('link', { name: 'Ver entrega', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Entrega #${deliveryId}` })).toBeVisible()
  await expect(page.getByText('O envio foi interrompido; a fila recuperou a tentativa.').filter({ visible: true })).toBeVisible()
  await expect(page.getByText('<script>window.webhookXss = true</script>', { exact: false })).toBeVisible()
  expect(await page.evaluate(() => Reflect.get(window, 'webhookXss'))).toBeUndefined()
  await page.getByRole('button', { name: 'Reenviar', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reenviar', exact: true }).click()
  await expect(page).toHaveURL(/deliveries\/9223372036854775801$/)
  await expect(page.getByText('Aguardando', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reenviar', exact: true })).toBeDisabled()
  await expect(page.getByRole('link', { name: `Reenvio da entrega #${deliveryId}` })).toBeVisible()
  expect(writes.filter(write => write.path.endsWith('/replay'))).toHaveLength(1)
})

test('unsaved configuration and server errors keep the editor open', async ({ page }) => {
  await setup(page, true)
  await page.getByRole('button', { name: 'Novo webhook', exact: true }).first().click()
  await page.getByRole('dialog').getByLabel('Nome', { exact: true }).fill('Rascunho')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar', exact: true }).click()
  await expect(page.getByRole('alertdialog', { name: 'Descartar alterações?' })).toBeVisible()
  await page.getByRole('button', { name: 'Continuar editando' }).click()
  await page.getByLabel('Tabela', { exact: true }).click()
  await page.getByRole('option', { name: 'notes', exact: true }).click()
  await page.getByLabel('URL de destino', { exact: true }).fill('https://127.0.0.1/hook')
  await page.route('**/admin/api/webhooks', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { code: 'webhook_invalid_url', error: 'Unsafe destination' } }) : route.fallback())
  await page.getByRole('dialog').getByRole('button', { name: 'Salvar', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Use uma URL HTTPS pública')
  await expect(page.getByRole('dialog').getByLabel('Nome', { exact: true })).toHaveValue('Rascunho')
})

test('the signing key survives Escape, outside clicks and navigation until acknowledged', async ({ page }) => {
  await setup(page)
  // Two in-app entries, so Back stays inside the panel's router.
  const views = page.locator('.panel-sidebar')
  await views.getByRole('link', { name: 'Histórico de entregas', exact: true }).click()
  await views.getByRole('link', { name: 'Webhooks', exact: true }).click()
  await page.getByRole('button', { name: 'Ações de Pedidos pagos', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Trocar chave', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Trocar chave', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Guarde a chave de assinatura' })
  await expect(dialog.getByText(secret, { exact: true })).toBeVisible()
  await page.mouse.click(5, 5)
  await page.keyboard.press('Escape')
  await expect(dialog.getByText(secret, { exact: true })).toBeVisible()
  // The guide opens in a new tab instead of unmounting the page with the key.
  await expect(dialog.getByRole('link', { name: 'Como receber e verificar eventos' })).toHaveAttribute('target', '_blank')
  // Back would unmount the page: it gets the same one-time warning instead.
  await page.goBack()
  await expect(dialog.getByRole('alert')).toContainText('ainda não copiou')
  await expect(dialog.getByRole('button', { name: 'Copiar chave', exact: true })).toBeFocused()
  await expect(page).toHaveURL(/\/admin\/webhooks$/)
  await dialog.getByRole('button', { name: 'Fechar sem copiar', exact: true }).click()
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0)
})

test('a webhook whose table was dropped says so and can still be paused, not resumed', async ({ page }) => {
  await setup(page)
  let enabled = true
  await page.route('**/admin/api/webhooks', route => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, json: { endpoints: [{ ...initial, table_available: false, enabled }], tables: ['orders'], allow_loopback: false, outstanding: 3, retained: 3 } })
    : route.fallback())
  await page.route(`**/admin/api/webhooks/${endpointId}`, route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    enabled = (route.request().postDataJSON() as { enabled: boolean }).enabled
    return route.fulfill({ status: 200, json: { ...initial, table_available: false, enabled } })
  })
  await page.reload()
  await expect(page.getByText('Sem tabela', { exact: true })).toBeVisible()
  await expect(page.getByText('Ativo', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Pausar', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Pausar webhook', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pausar', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ativar', exact: true })).toHaveCount(0)
  expect(enabled).toBe(false)
})

for (const locale of ['pt-BR', 'en']) {
  test(`events controls and guide remain usable at 320px in ${locale}`, async ({ page }) => {
    await page.addInitScript(locale => localStorage.setItem('nelcota.locale', locale), locale)
    await setup(page)
    await page.setViewportSize({ width: 320, height: 900 })
    await expect(page.getByRole('heading', { name: locale === 'en' ? 'Events and webhooks' : 'Eventos e webhooks', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.goto('/admin/webhooks?tab=deliveries')
    await expect(page.getByRole('link', { name: /Pedidos pagos/ })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    // At 320px the sidebar is a closed drawer; open the configuration view directly.
    await page.goto('/admin/webhooks')
    await page.getByRole('button', { name: locale === 'en' ? 'Edit' : 'Editar', exact: true }).click()
    await expect(page.getByLabel(locale === 'en' ? 'Destination URL' : 'URL de destino', { exact: true })).toHaveValue(initial.url)
    await page.getByRole('dialog').getByRole('button', { name: locale === 'en' ? 'Cancel' : 'Cancelar', exact: true }).click()
    await page.getByRole('link', { name: locale === 'en' ? 'How to receive and verify events' : 'Como receber e verificar eventos' }).click()
    await expect(page).toHaveURL(/guides\/webhooks$/)
    await expect(page.getByRole('heading', { name: locale === 'en' ? 'Verify signatures' : 'Verificar assinaturas', exact: true })).toBeVisible()
  })
}
