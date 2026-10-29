import type { DeniedRequests } from "$lib/contracts/types";

import { blockReason, blockTarget } from "../policies/blocked.js";

/** Projects the bounded recent refusal list into the dashboard's target and reason fields. */
export function recentRefusals(data: DeniedRequests | null, limit: number) {
  return data === null
    ? []
    : data.requests.slice(0, limit).map((request) => ({
        request,
        target: blockTarget(request.path),
        reason: blockReason(request),
      }));
}
