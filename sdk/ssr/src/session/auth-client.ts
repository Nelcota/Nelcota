import { createClient, NelcotaError, type FetchLike, type NelcotaClient } from "@nelcota/client";

import { SESSION_LIMITS, type SessionConfiguration } from "./configuration.js";
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

const REVOCATION_STORAGE_KEY = "nelcota-ssr.revocation.session";
/** Revocation runs after the response is decided; keep its delay short. */
const REVOCATION_TIMEOUT_IN_MS = 5_000;

/** Ends a replaced upstream session (its refresh token family) through the auth
 * logout endpoint. The token never leaves this function: it lives only in a
 * throwaway in-memory client storage. Throws on failure; callers treat it as
 * best effort.
 */
export async function revokeSession(config: SessionConfiguration, session: string): Promise<void> {
  const values = new Map<string, string>([[REVOCATION_STORAGE_KEY, session]]);
  const timeout = Math.min(
    config.options.timeout ?? SESSION_LIMITS.requestTimeoutInMs,
    REVOCATION_TIMEOUT_IN_MS,
  );
  const send = config.options.fetch ?? globalThis.fetch.bind(globalThis);
  const client = createClient(config.api.href, {
    auth: {
      autoRefresh: false,
      storageKey: REVOCATION_STORAGE_KEY,
      storage: {
        getItem: (name) => Promise.resolve(values.get(name) ?? null),
        setItem: (name, value) => {
          values.set(name, value);
          return Promise.resolve();
        },
        removeItem: (name) => {
          values.delete(name);
          return Promise.resolve();
        },
      },
    },
    timeout,
    retries: 0,
    fetch: (input, init) => send(input, { ...init, cache: "no-store", redirect: "error" }),
  });
  try {
    const result = await client.auth.signOut({ timeout });
    if (result.error !== null) throw result.error;
  } finally {
    client.dispose();
  }
}
