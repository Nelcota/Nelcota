import { describe, it, expect } from 'vitest'
import { parseDiagnostics, parseConfiguration, integer } from './contracts'
import { parseOperation, parsePending, terminal } from '../host/controller'
const diagnostics = { project: 'base', checked_at: 1000, memory_total_bytes: 8192, memory_available_bytes: 4096, cpu_percent: 25, load_one: 0.5, free_bytes: 123456, last_backup_at: null, last_offsite_backup_at: null, checks: [{ name: 'https', status: 'passed' }] }
const configuration = { project: 'base', fields: { NELCOTA_SMTP_FROM: 'Nelcota <mail@example.test>' }, smtp_configured: true, google_configured: false, github_configured: false, backup_configured: false, shared_login: true }
describe('server operator boundaries', () => {
  it('keeps absent measurements distinct from zero and rejects invalid numbers', () => {
    expect(parseDiagnostics({ ...diagnostics, cpu_percent: null }).cpu_percent).toBeNull()
    expect(parseDiagnostics({ ...diagnostics, cpu_percent: 0 }).cpu_percent).toBe(0)
    for (const cpu_percent of [NaN, Infinity, -1, 100.1, '0', undefined]) expect(() => parseDiagnostics({ ...diagnostics, cpu_percent })).toThrow()
    for (const memory_available_bytes of [8193, NaN, -1, 0.1]) expect(() => parseDiagnostics({ ...diagnostics, memory_available_bytes })).toThrow()
    expect(() => parseDiagnostics({ ...diagnostics, checks: [{ name: 'https', status: 'passed' }, { name: 'https', status: 'failed' }] })).toThrow()
  })
  it('refuses secret-bearing or unknown fields in a configuration response', () => {
    expect(parseConfiguration(configuration).smtp_configured).toBe(true)
    for (const key of ['NELCOTA_SMTP_URL', 'NELCOTA_ADMIN_PASSWORD_HASH', 'NELCOTA_BACKUP_S3_SECRET_KEY', '__proto__']) expect(() => parseConfiguration({ ...configuration, fields: { [key]: 'must-not-reach-browser' } })).toThrow()
    expect(() => parseConfiguration({ ...configuration, fields: null })).toThrow()
    expect(() => parseConfiguration({ ...configuration, shared_login: 'false' })).toThrow()
  })
  it('preserves a secret-free configuration identity across a lost response', () => {
    const operation = { kind: 'configure', project: 'base', section: 'smtp', revision: 'a'.repeat(64) }
    const pending = { plan: 'b'.repeat(64), key: 'c'.repeat(64), operation, confirmation: 'CONFIGURE base' }
    expect(parsePending(pending)).toEqual(pending)
    expect(parsePending({ ...pending, operation: { ...operation, revision: '../foreign' } })).toBeNull()
    expect(() => parseOperation({ ...operation, section: 'shell' })).toThrow()
    expect(terminal('rolled_back')).toBe(true)
    for (const kind of ['restart', 'backup_offsite', 'test_smtp', 'test_backup']) expect(parseOperation({ kind, project: 'base' }).project).toBe('base')
  })
  it('rejects empty, fractional, trailing-junk and infinite schedule fields', () => {
    for (const value of ['', ' 3', '3hours', '1.5', 'NaN', 'Infinity', '-1']) expect(integer(value, 0, 23)).toBeNull()
    expect(integer('23', 0, 23)).toBe(23)
    expect(integer('24', 0, 23)).toBeNull()
  })
})
