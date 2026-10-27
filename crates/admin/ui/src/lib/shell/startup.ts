// Startup decisions for main.ts, kept free of the DOM so they can be tested.

export type StartupPlan = {
  /** Start the /session check now, alongside the language download. */
  readonly checkSession: boolean
  /** Download the signed-in panel's code now instead of after the session check. */
  readonly prefetchPanel: boolean
}

/**
 * The updates controller has no panel session at all. A single sign-on token
 * is traded by App.svelte instead of checking the session. The panel's code is
 * only fetched early for a browser that was signed in last time.
 */
export function planStartup(input: { controller: boolean; handoffToken: string | null; signedInBefore: boolean }): StartupPlan {
  if (input.controller) return { checkSession: false, prefetchPanel: false }
  return { checkSession: input.handoffToken === null, prefetchPanel: input.signedInBefore }
}

/** Waits between attempts to download the active language before giving up. */
export const CATALOG_RETRY_DELAYS_MS: readonly number[] = [300, 1000]

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

/** Runs `attempt`, retrying after each delay; rejects with the last error when every try fails. */
export async function retry<T>(attempt: () => Promise<T>, delaysMs: readonly number[], wait: (milliseconds: number) => Promise<void> = pause): Promise<T> {
  for (const delay of delaysMs) {
    try {
      return await attempt()
    } catch (error) {
      console.warn(`Startup step failed; retrying in ${delay} ms`, error)
      await wait(delay)
    }
  }
  return attempt()
}
