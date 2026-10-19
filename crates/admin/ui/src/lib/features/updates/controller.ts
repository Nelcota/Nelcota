import { translate, i18n } from '$lib/i18n/index.svelte'
import { readBody } from '$lib/transport/read-body'
export const phases = ['preparing', 'pausing', 'capturing', 'backup_verified', 'activating', 'validating', 'committing', 'succeeded', 'recovering', 'resuming_previous', 'recovered', 'failed_before_change', 'needs_operator'] as const
export type Phase = typeof phases[number]
export type Job = { id: string; project: string; current: string; target: string; phase: Phase; sequence: number; updated_at: number; committed: boolean; error: string | null }
export type Status = { host_management?: boolean; host_busy?: boolean; email: string; projects: { name: string; version: string; update_available: boolean }[]; jobs: Job[]; release: { version: string } | null; enabled: boolean; checking: boolean; check_error: string | null }
export type Plan = { id: string; project: string; current: string; target: string; digest: string; expires_at: number; blockers: string[] }
export class ControllerError extends Error { constructor(public status: number, public code: string) { super(code) } }
export const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function parseJob(value: unknown): Job {
  if (!record(value) || !hash(value.id) || !text(value.project) || !text(value.current) || !text(value.target) || !phases.includes(value.phase as Phase) || !integer(value.sequence) || value.sequence === 0 || !integer(value.updated_at) || typeof value.committed !== 'boolean' || !(value.error === null || text(value.error))) throw new ControllerError(502, 'invalid_response')
  return value as Job
}
export function parseStatus(value: unknown): Status {
  if (!record(value) || !(value.host_management === undefined || typeof value.host_management === 'boolean') || !text(value.email) || !Array.isArray(value.projects) || value.projects.length > 32 || value.projects.some(p => !record(p) || !text(p.name) || !text(p.version) || typeof p.update_available !== 'boolean') || !Array.isArray(value.jobs) || value.jobs.length > 32 || typeof value.enabled !== 'boolean' || typeof value.checking !== 'boolean' || !(value.check_error === null || text(value.check_error)) || !(value.release === null || (record(value.release) && text(value.release.version)))) throw new ControllerError(502, 'invalid_response')
  return { ...value, jobs: value.jobs.map(parseJob) } as Status
}
export function parsePlan(value: unknown): Plan {
  if (!record(value) || !hash(value.id) || !hash(value.digest) || !text(value.project) || !text(value.current) || !text(value.target) || !integer(value.expires_at) || !Array.isArray(value.blockers) || value.blockers.length > 32 || !value.blockers.every(text)) throw new ControllerError(502, 'invalid_response')
  return value as Plan
}
export function mergeStatus(previous: Status | null, next: Status): Status {
  if (!previous || previous.email !== next.email) return next
  const jobs = next.jobs.map(job => { const old = previous.jobs.find(entry => entry.id === job.id); return old && old.sequence > job.sequence ? old : job })
  const missing = previous.jobs.filter(job => !terminal(job.phase) && !jobs.some(entry => entry.id === job.id) && next.projects.some(project => project.name === job.project))
  return { ...next, jobs: [...missing, ...jobs].slice(0, 32) }
}
export const terminal = (phase: Phase) => ['succeeded', 'recovered', 'failed_before_change'].includes(phase)
export function newKey(): string { return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
export function controllerOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try { const url = new URL(value); if (url.protocol === 'https:' && url.origin === value && !url.username && !url.password) return value } catch { return null }
  return null
}
export function message(code: string): string {
  const keys: Record<string, string> = { session_required: 'credentials', session_expired: 'credentials', invalid_credentials: 'credentials', reauthentication_failed: 'reauth', plan_changed: 'plan_changed', release_not_ready: 'release_not_ready' }
  return translate(i18n.locale, `updates.${keys[code] ?? 'blocked'}`)
}
export async function request(body?: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch('/admin/api/updates', { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json', 'X-Nelcota-Updates': '1' } : {}, body: body ? JSON.stringify(body) : undefined, signal })
  const status = response.ok ? 502 : response.status
  const code = response.ok ? 'invalid_response' : 'operation_blocked'
  const bounded = await readBody(response, response.ok ? 1024 * 1024 : 64 * 1024, signal)
  if (!bounded) throw new ControllerError(status, code)
  let value: unknown
  try { value = JSON.parse(await bounded.text()) }
  catch { throw new ControllerError(status, code) }
  if (!record(value)) throw new ControllerError(status, code)
  if (!response.ok || value.result === 'error') throw new ControllerError(response.status, typeof value.code === 'string' ? value.code : 'operation_blocked')
  return value
}
