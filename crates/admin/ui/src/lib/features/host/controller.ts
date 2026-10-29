import * as contracts from "$lib/generated/validators.js";

import type { Section } from "../server/contracts";
import { ControllerError, hash } from "../updates/controller";
const MAX_STATUS_TEXT_CHARS = 1024;
const HTTP_BAD_GATEWAY = 502;

const stages = [
  "accepted",
  "validating",
  "provisioning",
  "starting",
  "backing_up",
  "applying",
  "verifying",
  "completed",
  "rolled_back",
  "failed",
  "needs_attention",
] as const;
export type Stage = (typeof stages)[number];
export type Operation =
  | { kind: "create"; project: string; domain: string; profile: string }
  | {
      kind:
        | "backup"
        | "remove"
        | "restart"
        | "backup_offsite"
        | "test_smtp"
        | "test_backup"
        | "test_alerts";
      project: string;
    }
  | { kind: "configure"; project: string; section: Section; revision: string }
  | { kind: "restore"; project: string; backup: string };
export type Job = {
  affected_projects?: string[];
  last_stage?: Stage | null;
  id: string;
  request_key: string;
  operation: Operation;
  stage: Stage;
  sequence: number;
  updated_at: number;
  changed: boolean;
  backup: string | null;
  error: string | null;
};
type Project = {
  name: string;
  domain: string;
  version: string;
  app: string;
  database: string;
  backups: string[];
};
export type Status = {
  receipt: Job | null;
  enabled: boolean;
  busy?: boolean;
  projects: Project[];
  jobs: Job[];
  max_projects: number;
  ram_mb: number;
  free_bytes: number;
};
export type Plan = {
  affected_projects?: string[];
  id: string;
  operation: Operation;
  confirmation: string;
  expires_at: number;
  version: string;
  image_digest: string;
  blockers: string[];
  ram_mb: number;
  free_bytes: number;
  project_count: number;
  destructive: boolean;
};
export type Pending = {
  plan: string;
  key: string;
  operation: Operation;
  confirmation: string;
};
export type LogEntry = {
  timestamp: string;
  level: string;
  target: string;
  message: string;
};
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && Array.isArray(v) === false;
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length <= MAX_STATUS_TEXT_CHARS;
const LOG_LIMIT = 100;
function invalid(): never {
  throw new ControllerError(HTTP_BAD_GATEWAY, "invalid_response");
}
// The wire shapes come from the Rust contracts (D83); these are the rules
// that span several fields.
const confirms = (confirmation: string, operation: Operation) =>
  confirmation === `${operation.kind.toUpperCase()} ${operation.project}`;
function checkedJob(job: Job): Job {
  // Only an applied configuration change can be rolled back.
  if (job.stage === "rolled_back" && (job.operation.kind !== "configure" || job.changed === false))
    return invalid();
  return job;
}
export function parseOperation(v: unknown): Operation {
  if (contracts.HostOperation(v) === false) return invalid();
  return v as Operation;
}
export function parseJob(v: unknown): Job {
  if (contracts.HostJob(v) === false) return invalid();
  return checkedJob(v as Job);
}
export function parseStatus(v: unknown): Status {
  if (contracts.HostStatus(v) === false) return invalid();
  const status = v as Status;
  if (new Set(status.projects.map((p) => p.name)).size !== status.projects.length) return invalid();
  const receipt = status.receipt ?? null;
  return {
    ...status,
    receipt: receipt === null ? null : checkedJob(receipt),
    jobs: status.jobs.map(checkedJob),
  };
}
export function parsePlan(v: unknown): Plan {
  if (contracts.HostPlan(v) === false) return invalid();
  const plan = v as Plan;
  if (
    confirms(plan.confirmation, plan.operation) === false ||
    plan.destructive !== ["remove", "restore"].includes(plan.operation.kind)
  )
    return invalid();
  return plan;
}
export const terminal = (s: Stage) => s === "completed" || s === "failed" || s === "rolled_back";
export function mergeStatus(old: Status | null, next: Status, authoritative = false): Status {
  const incoming = receiptStatus(next);
  if (old == null) return incoming;
  const jobs = incoming.jobs.map((j) => {
    const previous = old.jobs.find((p) => p.id === j.id);
    return previous != null && previous.sequence > j.sequence ? previous : j;
  });
  // The server lists every unresolved job first. A fresh inventory can discard
  // cached active jobs that have since finished and left the bounded history.
  const active = old.jobs.filter(
    (j) =>
      authoritative === false &&
      terminal(j.stage) === false &&
      jobs.some((p) => p.id === j.id) === false,
  );
  return { ...incoming, jobs: [...active, ...jobs].slice(0, MAX_RECENT_JOBS) };
}
export function parsePending(v: unknown): Pending | null {
  try {
    if (
      object(v) === false ||
      hash(v.plan) === false ||
      hash(v.key) === false ||
      text(v.confirmation) === false
    )
      return null;
    const operation = parseOperation(v.operation);
    if (confirms(v.confirmation, operation) === false) return null;
    return { plan: v.plan, key: v.key, confirmation: v.confirmation, operation };
  } catch {
    return null;
  }
}
export function parseLogs(v: unknown): LogEntry[] {
  if (
    Array.isArray(v) === false ||
    v.length > LOG_LIMIT ||
    v.every((entry) => contracts.HostLogEntry(entry)) === false
  )
    return invalid();
  return v as LogEntry[];
}

function receiptStatus(status: Status): Status {
  const receipt = status.receipt;
  if (receipt == null || status.jobs.some((job) => job.id === receipt.id)) return status;
  return { ...status, jobs: [receipt, ...status.jobs].slice(0, MAX_RECENT_JOBS) };
}
const MAX_RECENT_JOBS = 32;
