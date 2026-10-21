import { ControllerError, hash } from '../updates/controller'
export const stages = [
  'accepted',
  'validating',
  'provisioning',
  'starting',
  'backing_up',
  'applying',
  'verifying',
  'completed',
  'failed',
  'needs_attention'
] as const
export type Stage = (typeof stages)[number]
export type Operation =
  | { kind: 'create'; project: string; domain: string; profile: string }
  | { kind: 'backup' | 'remove'; project: string }
  | { kind: 'restore'; project: string; backup: string }
export type Job = {
  last_stage?: Stage | null
  id: string
  request_key: string
  operation: Operation
  stage: Stage
  sequence: number
  updated_at: number
  changed: boolean
  backup: string | null
  error: string | null
}
export type Project = {
  name: string
  domain: string
  version: string
  app: string
  database: string
  backups: string[]
}
export type Status = {
  receipt: Job | null
  enabled: boolean
  busy?: boolean
  projects: Project[]
  jobs: Job[]
  max_projects: number
  ram_mb: number
  free_bytes: number
}
export type Plan = {
  id: string
  operation: Operation
  confirmation: string
  expires_at: number
  version: string
  image_digest: string
  blockers: string[]
  ram_mb: number
  free_bytes: number
  project_count: number
  destructive: boolean
}
export type Pending = {
  plan: string
  key: string
  operation: Operation
  confirmation: string
}
export type LogEntry = {
  timestamp: string
  level: string
  target: string
  message: string
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 1024
const uint = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const project = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-z0-9][a-z0-9-]{0,31}$/.test(v) &&
  !v.endsWith('-')
const domain = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 253 &&
  v.includes('.') &&
  v.split('.').every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))
const backup = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 200 &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.dump$/.test(v)
function invalid(): never {
  throw new ControllerError(502, 'invalid_response')
}
export function parseOperation(v: unknown): Operation {
  if (!object(v) || !project(v.project)) return invalid()
  if (v.kind === 'backup' || v.kind === 'remove')
    return { kind: v.kind, project: v.project }
  if (v.kind === 'restore' && backup(v.backup))
    return { kind: 'restore', project: v.project, backup: v.backup }
  if (
    v.kind === 'create' &&
    domain(v.domain) &&
    typeof v.profile === 'string' &&
    ['1gb', '2gb', '4gb', '8gb'].includes(v.profile)
  )
    return {
      kind: 'create',
      project: v.project,
      domain: v.domain,
      profile: v.profile
    }
  return invalid()
}
export function parseJob(v: unknown): Job {
  if (
    !object(v) ||
    !hash(v.id) ||
    !(v.last_stage == null || stages.includes(v.last_stage as Stage)) ||
    !hash(v.request_key) ||
    !stages.includes(v.stage as Stage) ||
    !uint(v.sequence) ||
    !v.sequence ||
    !uint(v.updated_at) ||
    typeof v.changed !== 'boolean' ||
    !(v.backup === null || backup(v.backup)) ||
    !(v.error === null || text(v.error))
  )
    return invalid()
  return { ...v, operation: parseOperation(v.operation) } as Job
}
export function parseStatus(v: unknown): Status {
  if (
    !object(v) ||
    (v.busy !== undefined && typeof v.busy !== 'boolean') ||
    typeof v.enabled !== 'boolean' ||
    !uint(v.max_projects) ||
    v.max_projects > 32 ||
    !uint(v.ram_mb) ||
    !uint(v.free_bytes) ||
    !Array.isArray(v.projects) ||
    v.projects.length > 32 ||
    !Array.isArray(v.jobs) ||
    v.jobs.length > 32
  )
    return invalid()
  const projects = v.projects.map((p) => {
    if (
      !object(p) ||
      !project(p.name) ||
      !domain(p.domain) ||
      !text(p.version) ||
      !text(p.app) ||
      !text(p.database) ||
      !Array.isArray(p.backups) ||
      p.backups.length > 32 ||
      !p.backups.every(backup)
    )
      return invalid()
    return p as Project
  })
  if (new Set(projects.map((p) => p.name)).size !== projects.length)
    return invalid()
  return {
    ...v,
    receipt: v.receipt == null ? null : parseJob(v.receipt),
    projects,
    jobs: v.jobs.map(parseJob)
  } as Status
}
export function parsePlan(v: unknown): Plan {
  if (
    !object(v) ||
    !hash(v.id) ||
    !hash(v.image_digest) ||
    !text(v.confirmation) ||
    !uint(v.expires_at) ||
    !text(v.version) ||
    !uint(v.ram_mb) ||
    !uint(v.free_bytes) ||
    !uint(v.project_count) ||
    typeof v.destructive !== 'boolean' ||
    !Array.isArray(v.blockers) ||
    v.blockers.length > 32 ||
    !v.blockers.every(text)
  )
    return invalid()
  const operation = parseOperation(v.operation)
  if (
    v.confirmation !== `${operation.kind.toUpperCase()} ${operation.project}` ||
    v.destructive !== ['remove', 'restore'].includes(operation.kind)
  )
    return invalid()
  return { ...v, operation } as Plan
}
export const terminal = (s: Stage) => s === 'completed' || s === 'failed'
export function mergeStatus(
  old: Status | null,
  next: Status,
  authoritative = false
): Status {
  const receipt = next.receipt
  if (receipt && !next.jobs.some((j) => j.id === receipt.id)) {
    next = { ...next, jobs: [receipt, ...next.jobs].slice(0, 32) }
  }
  if (!old) return next
  const jobs = next.jobs.map((j) => {
    const previous = old.jobs.find((p) => p.id === j.id)
    return previous && previous.sequence > j.sequence ? previous : j
  })
  // The server lists every unresolved job first. A fresh inventory can discard
  // cached active jobs that have since finished and left the bounded history.
  const active = old.jobs.filter(
    (j) =>
      !authoritative && !terminal(j.stage) && !jobs.some((p) => p.id === j.id)
  )
  return { ...next, jobs: [...active, ...jobs].slice(0, 32) }
}
export function parsePending(v: unknown): Pending | null {
  try {
    if (!object(v) || !hash(v.plan) || !hash(v.key) || !text(v.confirmation))
      return null
    const operation = parseOperation(v.operation)
    if (
      v.confirmation !== `${operation.kind.toUpperCase()} ${operation.project}`
    )
      return null
    return { plan: v.plan, key: v.key, confirmation: v.confirmation, operation }
  } catch {
    return null
  }
}
export function parseLogs(v: unknown): LogEntry[] {
  if (
    !Array.isArray(v) ||
    v.length > 100 ||
    v.some(
      (p) =>
        !object(p) ||
        !text(p.timestamp) ||
        !text(p.level) ||
        !text(p.target) ||
        p.message !== 'event_metadata_only'
    )
  )
    return invalid()
  return v as LogEntry[]
}
