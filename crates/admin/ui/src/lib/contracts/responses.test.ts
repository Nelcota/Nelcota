import { expect, it } from 'vitest'
import { responseContract } from './responses'

it('rejects incompatible rows and SQL results rather than trusting the client generic', () => {
  const sql = responseContract('POST', '/sql')!
  expect(sql({ results: [{ columns: ['id'], rows: [['9223372036854775807', null]], count: 1, truncated: false }], results_truncated: false })).toBe(true)
  expect(sql({ results: [{ columns: ['id'], rows: [[42]], count: 1, truncated: false }], results_truncated: false })).toBe(false)
  expect(sql({ error: { message: 'failed', code: null, hint: null, detail: null, position: null } })).toBe(true)
  expect(sql({ unexpected: 'result' })).toBe(false)
})
it('requires commit status and distinguishes preview from a committed change pending catalog refresh', () => {
  const ddl = responseContract('PATCH', '/tables/notes')!
  expect(ddl({ sql: ['ALTER TABLE notes ENABLE ROW LEVEL SECURITY'], applied: true, catalog_pending: true })).toBe(true)
  expect(ddl({ sql: ['SELECT 1'], applied: false, catalog_pending: false })).toBe(true)
  expect(ddl({ sql: ['SELECT 1'] })).toBe(false)
  expect(responseContract('POST', '/tables/notes/rows')).toBeUndefined()
})
it('requires enabled storage to carry its complete configuration', () => {
  const storage = responseContract('GET', '/storage')!
  expect(storage({ enabled: false })).toBe(true)
  expect(storage({ enabled: true })).toBe(false)
})

const endpoint = { id: 'endpoint', name: 'Orders', schema: 'public', table: 'orders', table_available: true, url: 'https://example.com/hook', events: ['INSERT'], enabled: true, max_attempts: 6, created_at: '2026-10-11T12:00:00Z' }
const delivery = { id: '9223372036854775800', endpoint_id: endpoint.id, endpoint_name: endpoint.name, endpoint_enabled: true, event_id: 'event', replay_of: null, schema: 'public', table: 'orders', event: 'INSERT', url: endpoint.url, status: 'pending', attempts: 0, max_attempts: 6, created_at: endpoint.created_at, next_attempt_at: endpoint.created_at, finished_at: null, last_status: null, last_error: null }

it.each([
  ['GET', '/webhooks', { endpoints: [endpoint], tables: ['orders'], allow_loopback: false, outstanding: 1, retained: 1 }],
  ['GET', '/webhooks/deliveries?status=pending', { deliveries: [delivery], next_cursor: null }],
  ['GET', '/webhooks/deliveries/9223372036854775800', { delivery, payload: '{}', attempts: [] }],
  ['POST', '/webhooks', { endpoint, secret: 'whsec_test' }],
  ['POST', '/webhooks/endpoint/rotate', { endpoint, secret: 'whsec_rotated' }],
  ['PUT', '/webhooks/endpoint', endpoint],
  ['POST', '/webhooks/deliveries/9223372036854775800/replay', { id: '9223372036854775801' }],
  ['DELETE', '/webhooks/deliveries', { deleted: 1 }],
] as const)('validates the webhook response for %s %s', (method, path, valid) => {
  const validator = responseContract(method, path)
  expect(validator).toBeTypeOf('function')
  expect(validator!(valid)).toBe(true)
  expect(validator!({ unexpected: 'response' })).toBe(false)
})
