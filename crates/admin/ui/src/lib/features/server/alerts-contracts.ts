import * as contracts from '$lib/generated/validators.js'
import { ControllerError } from '../updates/controller'
export type AlertSettings = { enabled: boolean; email_enabled: boolean; webhook_enabled: boolean; heartbeat_enabled: boolean; smtp_project: string; recipient: string; disk_percent: number; disk_gib: number; certificate_days: number; backup_hours: number; reminder_hours: number }
export const alertKinds = ['application', 'database', 'https', 'certificate', 'disk', 'backup_late', 'backup_failed', 'monitoring'] as const
export type Incident = { key: string; project: string | null; kind: typeof alertKinds[number]; severity: 'warning' | 'critical'; active: boolean; since: number; changed_at: number }
export type AlertChannel = { channel: 'email' | 'webhook'; last_success_at: number | null; last_error: string | null; next_attempt_at: number | null }
export type AlertStatus = { settings: AlertSettings; recipients: string[]; projects: string[]; webhook_configured: boolean; heartbeat_configured: boolean; webhook_host: string | null; heartbeat_host: string | null; last_scan_at: number | null; heartbeat_accepted_at: number | null; heartbeat_error: string | null; monitor_error: string | null; maintenance: boolean; incidents: Incident[]; channels: AlertChannel[] }
function invalid(): never { throw new ControllerError(502, 'invalid_response') }
// The wire shapes come from the Rust contracts (D83); these rules span several values.
export function parseAlertStatus(v: unknown): AlertStatus {
  if (contracts.HostAlertStatus(v) === false) return invalid()
  const status = v as AlertStatus
  // An incident key names its kind, and its project unless it is host-wide.
  if (status.incidents.some(i => i.key.endsWith(`.${i.kind}`) === false || (i.project === null) !== i.key.startsWith('host.'))) return invalid()
  if (new Set(status.incidents.map(i => i.key)).size !== status.incidents.length) return invalid()
  if (new Set(status.channels.map(c => c.channel)).size !== status.channels.length) return invalid()
  return status
}
