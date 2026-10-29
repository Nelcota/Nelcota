import * as contracts from "$lib/generated/validators.js";
import { translate, i18n } from "$lib/i18n/index.svelte";
import { deadlineSignal } from "$lib/transport/deadline";
import { readBody } from "$lib/transport/read-body";
const HTTP_BAD_GATEWAY = 502;
const MAX_RECENT_JOBS = 32;
const HEX_RADIX = 16;
const HTTP_UNAUTHORIZED = 401;
const REQUEST_KEY_BYTES = 32;

const RESPONSE_LIMITS = { successBytes: 1_048_576, errorBytes: 65_536 } as const;

const phases = [
  "preparing",
  "pausing",
  "capturing",
  "backup_verified",
  "activating",
  "validating",
  "committing",
  "succeeded",
  "recovering",
  "resuming_previous",
  "recovered",
  "failed_before_change",
  "needs_operator",
] as const;
export type Phase = (typeof phases)[number];
export type Job = {
  id: string;
  project: string;
  current: string;
  target: string;
  phase: Phase;
  sequence: number;
  updated_at: number;
  committed: boolean;
  error: string | null;
};
export type Status = {
  host_management?: boolean;
  host_busy?: boolean;
  email: string;
  projects: { name: string; version: string; update_available: boolean }[];
  jobs: Job[];
  release: { version: string } | null;
  enabled: boolean;
  checking: boolean;
  check_error: string | null;
};
export type Plan = {
  id: string;
  project: string;
  current: string;
  target: string;
  digest: string;
  expires_at: number;
  blockers: string[];
};
export class ControllerError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
    this.name = "ControllerError";
  }
}
export const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && Array.isArray(value) === false;
function invalid(): never {
  throw new ControllerError(HTTP_BAD_GATEWAY, "invalid_response");
}
// The wire shapes come from the Rust contracts (D83).
export function parseJob(value: unknown): Job {
  if (contracts.UpdateJob(value) === false) return invalid();
  return value as Job;
}
export function parseStatus(value: unknown): Status {
  if (contracts.UpdateStatus(value) === false) return invalid();
  return value as Status;
}
export function parsePlan(value: unknown): Plan {
  if (contracts.UpdatePlan(value) === false) return invalid();
  return value as Plan;
}
export function mergeStatus(previous: Status | null, next: Status): Status {
  if (previous == null || previous.email !== next.email) return next;
  const jobs = next.jobs.map((job) => {
    const old = previous.jobs.find((entry) => entry.id === job.id);
    return old != null && old.sequence > job.sequence ? old : job;
  });
  const missing = previous.jobs.filter(
    (job) =>
      terminal(job.phase) === false &&
      jobs.some((entry) => entry.id === job.id) === false &&
      next.projects.some((project) => project.name === job.project),
  );
  return { ...next, jobs: [...missing, ...jobs].slice(0, MAX_RECENT_JOBS) };
}
export const terminal = (phase: Phase) =>
  ["succeeded", "recovered", "failed_before_change"].includes(phase);
export function newKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(REQUEST_KEY_BYTES))]
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, "0"))
    .join("");
}
export function controllerOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.origin === value &&
      url.username === "" &&
      url.password === ""
    )
      return value;
  } catch {
    return null;
  }
  return null;
}
export function message(code: string): string {
  const keys: Record<string, string> = {
    session_required: "credentials",
    session_expired: "credentials",
    invalid_credentials: "credentials",
    reauthentication_failed: "reauth",
    plan_changed: "plan_changed",
    release_not_ready: "release_not_ready",
  };
  return translate(i18n.locale, `updates.${keys[code] ?? "blocked"}`);
}
/** Every controller call gives up after this long, even when the caller never aborts. */
export const REQUEST_TIMEOUT_MS = 20000;
/** Fastest poll while work runs, and the backoff base and ceiling while unreachable. */
const ACTIVE_POLL_MS = 2000;
const MAX_RETRY_POLL_MS = 30000;
const MAX_RETRY_DOUBLINGS = 4;
/** Next poll: exponential backoff while offline, fast while work runs, else the idle interval. */
export function pollDelay(state: {
  offline: boolean;
  attempts: number;
  active: boolean;
  idleMs: number;
}): number {
  if (state.offline)
    return Math.min(
      MAX_RETRY_POLL_MS,
      ACTIVE_POLL_MS * 2 ** Math.min(state.attempts, MAX_RETRY_DOUBLINGS),
    );
  if (state.active) return ACTIVE_POLL_MS;
  return state.idleMs;
}
export const sessionExpired = (error: unknown) =>
  error instanceof ControllerError && error.status === HTTP_UNAUTHORIZED;
export async function request(
  body?: object,
  caller?: AbortSignal,
): Promise<Record<string, unknown>> {
  const signal = deadlineSignal(caller, REQUEST_TIMEOUT_MS);
  const response = await fetch("/admin/api/updates", updateRequest(body, signal));
  const status = response.ok ? HTTP_BAD_GATEWAY : response.status;
  const code = response.ok ? "invalid_response" : "operation_blocked";
  const bounded = await readBody(
    response,
    response.ok ? RESPONSE_LIMITS.successBytes : RESPONSE_LIMITS.errorBytes,
    signal,
  );
  if (bounded == null) throw new ControllerError(status, code);
  let value: unknown;
  try {
    value = JSON.parse(await bounded.text());
  } catch {
    throw new ControllerError(status, code);
  }
  if (record(value) === false) throw new ControllerError(status, code);
  if (response.ok === false || value.result === "error")
    throw new ControllerError(
      response.status,
      typeof value.code === "string" ? value.code : "operation_blocked",
    );
  return value;
}

function updateRequest(body: object | undefined, signal: AbortSignal): RequestInit {
  return {
    method: body != null ? "POST" : "GET",
    credentials: "same-origin",
    headers: body != null ? { "Content-Type": "application/json", "X-Nelcota-Updates": "1" } : {},
    body: body != null ? JSON.stringify(body) : undefined,
    signal,
  };
}
