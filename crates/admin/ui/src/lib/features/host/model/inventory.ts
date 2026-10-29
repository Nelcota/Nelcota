import { mergeStatus, type Job, type Pending, type Plan, type Status } from "../controller";
type Review = { pending: Pending | null; recovery: Job | null; requestedKey: string | null };

/** Reconciles a captured request with an authoritative inventory. */
export function inventoryOutcome(status: Status, review: Review) {
  const acknowledged = acknowledgedRequest(status, review);
  const recovered =
    review.recovery !== null &&
    status.jobs.some((job) => job.id === review.recovery?.id && job.stage !== "needs_attention");
  return {
    acknowledged,
    submitted: acknowledged || recovered,
    mayReject:
      acknowledged === false &&
      recovered === false &&
      review.pending?.key === review.requestedKey &&
      status.receipt === null,
  };
}
function acknowledgedRequest(status: Status, review: Review): boolean {
  const pending = review.pending;
  return (
    pending !== null &&
    pending.key === review.requestedKey &&
    (status.receipt?.request_key === pending.key ||
      status.jobs.some((job) => job.request_key === pending.key))
  );
}
/** Keeps the first project as the initial selection and detects deleted selections. */
export function inventorySelection(status: Status, current: string) {
  const selected = current === "" ? (status.projects[0]?.name ?? "") : current;
  const removed =
    selected !== "" && status.projects.some((project) => project.name === selected) === false;
  return { selected: removed ? "" : selected, removed };
}

const MAX_RECENT_JOBS = 32;
/** Retains newer cached sequences when an accepted job joins the recent history. */
export function acceptedJob(status: Status | null, job: Job): Status | null {
  if (status === null) return null;
  return mergeStatus(status, {
    ...status,
    jobs: [job, ...status.jobs.filter((entry) => entry.id !== job.id)].slice(0, MAX_RECENT_JOBS),
  });
}

const PLAN_TTL_SECONDS = 300;
/** Caps the approval countdown at the controller's maximum plan lifetime. */
export function planSeconds(plan: Plan | null, now: number): number {
  return plan === null ? 0 : Math.min(PLAN_TTL_SECONDS, Math.max(0, plan.expires_at - now));
}
