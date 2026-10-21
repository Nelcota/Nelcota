import { ControllerError } from '../updates/controller'
export type AlertSettings = { enabled: boolean; email_enabled: boolean; webhook_enabled: boolean; heartbeat_enabled: boolean; smtp_project: string; recipient: string; disk_percent: number; disk_gib: number; certificate_days: number; backup_hours: number; reminder_hours: number }
export const alertKinds = ['application', 'database', 'https', 'certificate', 'disk', 'backup_late', 'backup_failed', 'monitoring'] as const
export type Incident = { key: string; project: string | null; kind: typeof alertKinds[number]; severity: 'warning' | 'critical'; active: boolean; since: number; changed_at: number }
export type AlertChannel = { channel: 'email' | 'webhook'; last_success_at: number | null; last_error: string | null; next_attempt_at: number | null }
export type AlertStatus = { settings: AlertSettings; recipients: string[]; projects: string[]; webhook_configured: boolean; heartbeat_configured: boolean; webhook_host: string | null; heartbeat_host: string | null; last_scan_at: number | null; heartbeat_accepted_at: number | null; heartbeat_error: string | null; monitor_error: string | null; maintenance: boolean; incidents: Incident[]; channels: AlertChannel[] }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const project = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(v) && !v.endsWith('-')
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f]/.test(v)
const time = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000
const optionalTime = (v: unknown): boolean => v === null || time(v)
const range = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
const host = (v: unknown): boolean => v === null || (text(v, 253) && /^[a-z0-9.-]+$/.test(v))
function invalid(): never { throw new ControllerError(502, 'invalid_response') }
export function parseAlertSettings(v: unknown): AlertSettings {
  if (!object(v) || ['enabled', 'email_enabled', 'webhook_enabled', 'heartbeat_enabled'].some(k => typeof v[k] !== 'boolean') || !text(v.smtp_project, 32) || !text(v.recipient, 254)) return invalid()
  if (v.smtp_project !== '' && !project(v.smtp_project)) return invalid()
  for (const [key, min, max] of [['disk_percent', 5, 50], ['disk_gib', 1, 1024], ['certificate_days', 1, 60], ['backup_hours', 1, 168], ['reminder_hours', 1, 168]] as const) if (!range(v[key], min, max)) return invalid()
  if (Object.keys(v).some(k => !['enabled', 'email_enabled', 'webhook_enabled', 'heartbeat_enabled', 'smtp_project', 'recipient', 'disk_percent', 'disk_gib', 'certificate_days', 'backup_hours', 'reminder_hours'].includes(k))) return invalid()
  return v as AlertSettings
}
export function parseAlertStatus(v: unknown): AlertStatus {
  const keys = ['settings', 'recipients', 'projects', 'webhook_configured', 'heartbeat_configured', 'webhook_host', 'heartbeat_host', 'last_scan_at', 'heartbeat_accepted_at', 'heartbeat_error', 'monitor_error', 'maintenance', 'incidents', 'channels']
  if (!object(v) || Object.keys(v).some(k => !keys.includes(k)) || ['webhook_configured', 'heartbeat_configured', 'maintenance'].some(k => typeof v[k] !== 'boolean') || !['last_scan_at', 'heartbeat_accepted_at'].every(k => optionalTime(v[k])) || !host(v.webhook_host) || !host(v.heartbeat_host)) return invalid()
  if (!Array.isArray(v.recipients) || v.recipients.length > 16 || !v.recipients.every(r => text(r, 254)) || !Array.isArray(v.projects) || v.projects.length > 32 || !v.projects.every(project)) return invalid()
  if (new Set(v.projects).size !== v.projects.length || new Set(v.recipients).size !== v.recipients.length) return invalid()
  for (const key of ['heartbeat_error', 'monitor_error']) if (v[key] !== null && !['alert_heartbeat_failed', 'alert_probe_failed', 'alert_state_unavailable', 'alert_configuration_invalid', 'alert_observer_unavailable', 'alert_policy_changed'].includes(String(v[key]))) return invalid()
  if (!Array.isArray(v.incidents) || v.incidents.length > 258 || !Array.isArray(v.channels) || v.channels.length > 2) return invalid()
  const incidents = v.incidents.map(i => {
    if (!object(i) || !text(i.key, 100) || !/^(host\.(disk|monitoring)|[a-f0-9]{64}\.[a-z_]{1,20})$/.test(i.key) || !(i.project === null || project(i.project)) || !alertKinds.includes(i.kind as Incident['kind']) || !['warning', 'critical'].includes(String(i.severity)) || typeof i.active !== 'boolean' || !time(i.since) || !time(i.changed_at)) return invalid()
    if (!i.key.endsWith(`.${String(i.kind)}`) || ((i.project === null) !== i.key.startsWith('host.'))) return invalid()
    return i as Incident
  })
  const channels = v.channels.map(c => {
    if (!object(c) || !['email', 'webhook'].includes(String(c.channel)) || !optionalTime(c.last_success_at) || !optionalTime(c.next_attempt_at) || !(c.last_error === null || c.last_error === 'alert_delivery_failed')) return invalid()
    return c as AlertChannel
  })
  if (new Set(incidents.map(i => i.key)).size !== incidents.length || new Set(channels.map(c => c.channel)).size !== channels.length) return invalid()
  return { ...v, settings: parseAlertSettings(v.settings), incidents, channels } as AlertStatus
}
