import { createClient, NelcotaError, type FetchLike, type NelcotaClient } from "@nelcota/client";

import { SESSION_LIMITS } from "./configuration.js";
import type { WriteState } from "./write-state.js";

function authFetch(state: WriteState): FetchLike {
  return async (input, init) => {
    state.ensure();
    const options = state.records.config.options;
    const budgetInMs = Math.min(
      options.timeout ?? SESSION_LIMITS.requestTimeoutInMs,
      state.lease.deadline - Date.now(),
    );
    if (budgetInMs < 100)
      throw new NelcotaError({
        status: 0,
        code: "lease_exhausted",
        message: "The session lease cannot fit another auth request",
      });
    const signal = AbortSignal.any([
      ...(init?.signal != null ? [init.signal] : []),
      state.lease.signal,
      AbortSignal.timeout(budgetInMs),
    ]);
    return await (options.fetch ?? globalThis.fetch.bind(globalThis))(input, {
      ...init,
      signal,
      cache: "no-store",
      redirect: "error",
    });
  };
}

/** Authentication finishes within the lease that must persist its result. */
export function authenticationClient<Database>(state: WriteState): NelcotaClient<Database> {
  const config = state.records.config;
  return createClient<Database>(config.api.href, {
    auth: { autoRefresh: false, storage: state.storage, storageKey: state.storageKey },
    timeout: config.options.timeout ?? SESSION_LIMITS.requestTimeoutInMs,
    retries: 0,
    fetch: authFetch(state),
  });
}
