import { ControllerError } from "../../updates/controller";
import type { Job, Pending, Plan } from "../controller";
type Approval = {
  recovery: Job | null;
  pending: Pending | null;
  plan: Plan | null;
  key: string;
  password: string;
  confirmation: string;
};

/** Persists the request identity before sending an operation that can commit. */
export function approvalBody(
  state: Approval,
  savePending: (value: Pending) => boolean,
): object | null {
  if (state.recovery !== null)
    return {
      action: "host_recover",
      job: state.recovery.id,
      password: state.password,
      confirmation: state.confirmation,
    };
  const value = state.pending ?? plannedRequest(state.plan, state.key);
  if (value === null || savePending(value) === false) return null;
  return {
    action: "host_start",
    plan: value.plan,
    key: value.key,
    password: state.password,
    confirmation: state.confirmation,
  };
}
function plannedRequest(plan: Plan | null, key: string): Pending | null {
  return plan === null
    ? null
    : {
        plan: plan.id,
        key,
        operation: plan.operation,
        confirmation: plan.confirmation,
      };
}

/** Explicit controller rejections can clear an unacknowledged pending request. */
export function rejectedApproval(error: unknown): boolean {
  return (
    error instanceof ControllerError &&
    ["reauthentication_failed", "plan_expired", "plan_blocked", "plan_changed"].includes(error.code)
  );
}
