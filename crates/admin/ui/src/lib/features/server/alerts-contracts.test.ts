import { describe, it, expect } from 'vitest'
import { parseAlertSettings, parseAlertStatus } from './alerts-contracts'
const settings = { enabled: false, email_enabled: false, webhook_enabled: false, heartbeat_enabled: false, smtp_project: '', recipient: '', disk_percent: 15, disk_gib: 3, certificate_days: 14, backup_hours: 26, reminder_hours: 24 }
const status = { settings, recipients: ['operator@example.test'], projects: ['base'], webhook_configured: false, heartbeat_configured: false, webhook_host: null, heartbeat_host: null, last_scan_at: null, heartbeat_accepted_at: null, heartbeat_error: null, monitor_error: null, maintenance: false, incidents: [], channels: [] }
const incident = { key: 'host.disk', project: null, kind: 'disk', severity: 'critical', active: true, since: 100, changed_at: 200 }
describe('operational alert response boundary', () => {
  it('keeps disabled, empty, unknown and zero states distinct', () => {
    expect(parseAlertStatus(status)).toEqual(status)
    expect(parseAlertStatus({ ...status, last_scan_at: 0 }).last_scan_at).toBe(0)
    for (const value of [undefined, null, [], {}, '']) expect(() => parseAlertStatus(value)).toThrow()
    for (const last_scan_at of [NaN, Infinity, -1, 0.5, '1', 8_640_000_000_001]) expect(() => parseAlertStatus({ ...status, last_scan_at })).toThrow()
    for (const disk_percent of [0, 51, NaN, Infinity, '15', null]) expect(() => parseAlertSettings({ ...settings, disk_percent })).toThrow()
    expect(() => parseAlertSettings({ ...settings, enabled: 'false' })).toThrow()
  })
  it('refuses secret-bearing status/settings and duplicate or forged incident identities', () => {
    expect(() => parseAlertStatus({ ...status, webhook_url: 'https://private.test/token' })).toThrow()
    expect(() => parseAlertSettings({ ...settings, smtp_url: 'smtps://secret' })).toThrow()
    expect(() => parseAlertStatus({ ...status, incidents: [incident, incident] })).toThrow()
    expect(() => parseAlertStatus({ ...status, incidents: [{ ...incident, kind: 'database' }] })).toThrow()
    expect(() => parseAlertStatus({ ...status, incidents: [{ ...incident, project: 'base' }] })).toThrow()
    expect(() => parseAlertStatus({ ...status, projects: ['base', 'base'] })).toThrow()
    expect(() => parseAlertStatus({ ...status, monitor_error: 'raw provider error with secret' })).toThrow()
    expect(parseAlertStatus({ ...status, incidents: [incident] }).incidents).toEqual([incident])
  })
  it('bounds channels and exposes only closed delivery errors', () => {
    const channel = { channel: 'email', last_success_at: null, last_error: 'alert_delivery_failed', next_attempt_at: 123 }
    expect(parseAlertStatus({ ...status, channels: [channel] }).channels[0].last_error).toBe('alert_delivery_failed')
    expect(() => parseAlertStatus({ ...status, channels: [channel, channel] })).toThrow()
    expect(() => parseAlertStatus({ ...status, channels: [{ ...channel, next_attempt_at: Infinity }] })).toThrow()
    expect(() => parseAlertStatus({ ...status, channels: [{ ...channel, last_error: 'smtp password' }] })).toThrow()
  })
})
