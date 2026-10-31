// Admin session: `undefined` = checking, `null` = signed out. `expired` is set
// when a signed-in session is rejected (401), so the login can say why.
export const session = $state<{
  email: string | null | undefined;
  expired: boolean;
  epoch: number;
}>({ email: undefined, expired: false, epoch: 0 });

const endedCleanups = new Set<() => void>();

/**
 * Runs `cleanup` whenever the session ends: sign-out, expiry or sign-out in
 * another tab. Features register what the browser must not keep after the
 * session (for example SQL history), without transport importing them.
 *
 * @returns A function that unregisters the cleanup.
 */
export function onSessionEnded(cleanup: () => void): () => void {
  endedCleanups.add(cleanup);
  return () => endedCleanups.delete(cleanup);
}

/**
 * Signs the panel out locally and runs the registered cleanups.
 *
 * @param expired - Whether the login screen says the session expired.
 */
export function endSession(expired: boolean): void {
  session.expired = expired;
  session.email = null;
  for (const cleanup of endedCleanups) cleanup();
}
