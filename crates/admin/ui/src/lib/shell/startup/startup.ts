const CATALOG_RETRY = { initialInMs: 300, followupInMs: 1000 } as const;
// Startup decisions for main.ts, kept free of the DOM so they can be tested.

export type StartupPlan = {
  /** Start the /session check now, alongside the language download. */
  readonly checkSession: boolean;
  /** Download the signed-in panel's code now instead of after the session check. */
  readonly prefetchPanel: boolean;
};

/**
 * The updates controller has no panel session at all. A single sign-on token
 * is traded by app.svelte instead of checking the session. The panel's code is
 * only fetched early for a browser that was signed in last time.
 */
export function planStartup(input: {
  controller: boolean;
  handoffToken: string | null;
  signedInBefore: boolean;
}): StartupPlan {
  if (input.controller) return { checkSession: false, prefetchPanel: false };
  return { checkSession: input.handoffToken === null, prefetchPanel: input.signedInBefore };
}

/** Waits between attempts to download the active language before giving up. */
export const CATALOG_RETRY_DELAYS_MS: readonly number[] = [
  CATALOG_RETRY.initialInMs,
  CATALOG_RETRY.followupInMs,
];

const pause = (millisecondsInMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, millisecondsInMs));

/** Runs `attempt`, retrying after each delay; rejects with the last error when every try fails. */
export async function retry<T>(
  attempt: () => Promise<T>,
  delaysMs: readonly number[],
  wait: (milliseconds: number) => Promise<void> = pause,
): Promise<T> {
  for (const delay of delaysMs) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- A retry starts only after the preceding attempt fails and its backoff finishes.
      return await attempt();
    } catch (error) {
      console.warn(`Startup step failed; retrying in ${delay} ms`, error);
      // oxlint-disable-next-line no-await-in-loop -- A retry starts only after the preceding attempt fails and its backoff finishes.
      await wait(delay);
    }
  }
  return await attempt();
}
