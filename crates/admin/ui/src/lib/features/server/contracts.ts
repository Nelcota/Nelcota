import { ControllerError, hash } from '../updates/controller'
export const sections = ['smtp', 'oauth_google', 'oauth_github', 'backup', 'schedule', 'admin_password'] as const
export type Section = typeof sections[number]
export type Configuration =
  | { section: 'smtp'; enabled: boolean; url: string | null; from: string; recovery_url: string; confirmation_url: string; magic_link_url: string }
  | { section: 'oauth_google' | 'oauth_github'; enabled: boolean; client_id: string; client_secret: string | null; redirects: string[] }
  | { section: 'backup'; enabled: boolean; endpoint: string; bucket: string; region: string; access_key: string | null; secret_key: string | null }
  | { section: 'schedule'; hour: number; minute: number; keep: number }
  | { section: 'admin_password'; new_password: string }
export type ConfigurationView = { project: string; fields: Record<string, string>; smtp_configured: boolean; google_configured: boolean; github_configured: boolean; backup_configured: boolean; shared_login: boolean }
export type CheckStatus = 'passed' | 'warning' | 'failed' | 'unavailable'
export type Diagnostics = { project: string; checked_at: number; memory_total_bytes: number | null; memory_available_bytes: number | null; cpu_percent: number | null; load_one: number | null; free_bytes: number; last_backup_at: number | null; last_offsite_backup_at: number | null; checks: { name: string; status: CheckStatus }[] }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const uint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const project = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(v) && !v.endsWith('-')
function invalid(): never { throw new ControllerError(502, 'invalid_response') }
export function isSection(v: unknown): v is Section { return typeof v === 'string' && sections.some(s => s === v) }
export function revision(v: unknown): v is string { return hash(v) }
export function parseConfiguration(v: unknown): ConfigurationView {
  if (!object(v) || !project(v.project) || !object(v.fields) || ['smtp_configured', 'google_configured', 'github_configured', 'backup_configured', 'shared_login'].some(k => typeof v[k] !== 'boolean')) return invalid()
  const allowed = ['NELCOTA_SMTP_FROM', 'NELCOTA_PASSWORD_RECOVERY_URL', 'NELCOTA_EMAIL_CONFIRMATION_URL', 'NELCOTA_MAGIC_LINK_URL', 'NELCOTA_OAUTH_GOOGLE_CLIENT_ID', 'NELCOTA_OAUTH_GITHUB_CLIENT_ID', 'NELCOTA_OAUTH_REDIRECT_URLS', 'NELCOTA_BACKUP_S3_ENDPOINT', 'NELCOTA_BACKUP_S3_BUCKET', 'NELCOTA_BACKUP_S3_REGION', 'BACKUP_HOUR', 'BACKUP_MINUTE', 'BACKUP_KEEP']
  if (Object.entries(v.fields).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f]/.test(value))) return invalid()
  return v as ConfigurationView
}
export function parseDiagnostics(v: unknown): Diagnostics {
  if (!object(v) || !project(v.project) || !uint(v.checked_at) || !uint(v.free_bytes) || !Array.isArray(v.checks) || v.checks.length > 32) return invalid()
  for (const key of ['memory_total_bytes', 'memory_available_bytes', 'last_backup_at', 'last_offsite_backup_at']) if (v[key] !== null && !uint(v[key])) return invalid()
  for (const key of ['cpu_percent', 'load_one']) if (v[key] !== null && !finite(v[key])) return invalid()
  if (typeof v.cpu_percent === 'number' && v.cpu_percent > 100) return invalid()
  if (typeof v.memory_total_bytes === 'number' && typeof v.memory_available_bytes === 'number' && v.memory_available_bytes > v.memory_total_bytes) return invalid()
  const checks = v.checks.map(check => {
    if (!object(check) || typeof check.name !== 'string' || !/^[a-z_]{1,40}$/.test(check.name) || typeof check.status !== 'string' || !['passed', 'warning', 'failed', 'unavailable'].includes(check.status)) return invalid()
    return check as { name: string; status: CheckStatus }
  })
  if (new Set(checks.map(c => c.name)).size !== checks.length) return invalid()
  return { ...v, checks } as Diagnostics
}
export function integer(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const n = Number.parseInt(value, 10)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null
}
