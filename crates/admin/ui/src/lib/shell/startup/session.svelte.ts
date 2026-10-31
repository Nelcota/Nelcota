import { preloadResponseContracts } from "$lib/contracts/responses";
import { forgetSessionWork, hasSessionWork } from "$lib/features/sql/session-work";
import { clearQuerySession } from "$lib/resources/query-client";
import { endSession, session } from "$lib/resources/session.svelte";
import { api, ApiError } from "$lib/transport/api";

import { rememberSignedIn, wasSignedIn, watchSignOutElsewhere } from "../prefetch.js";
const HTTP_UNAUTHORIZED = 401;

/**
 * The session ended while no tab was open (it expired or was revoked): the
 * browser was signed in, yet still holds SQL history or drafts. Runs the same
 * session-ended path as a sign-out, whose cleanups the auth module registers.
 */
async function endStaleSession(): Promise<void> {
  try {
    await import("$lib/features/auth/auth");
    endSession(false);
  } catch (error) {
    // Without the module, still forget what the cleanup would have removed.
    console.warn("Could not load the sign-out cleanups; clearing the SQL history directly", error);
    forgetSessionWork();
  }
}

/** Owns startup session requests and cross-tab sign-out without rendering pages early. */
export class StartupSession {
  offline = $state<unknown>(null);
  checking = $state(false);
  async start(
    handoffToken: string | null,
    sessionCheck?: Promise<{ email: string }>,
  ): Promise<void> {
    if (handoffToken === null) {
      await this.check(sessionCheck ?? undefined);
      return;
    }
    // Coming from another panel on the host (single sign-on): trade the token for a session.
    try {
      session.email = (await api.post<{ email: string }>("/sso", { token: handoffToken })).email;
      return;
    } catch {
      // Expired or already used token: fall back to the normal login.
    }
    await this.check();
  }

  async check(pending: Promise<{ email: string }> = api.get<{ email: string }>("/session")) {
    this.checking = true;
    try {
      const me = await pending;
      this.offline = null;
      session.email = me.email;
    } catch (e) {
      if (e instanceof ApiError && e.status === HTTP_UNAUTHORIZED) {
        await this.signedOut();
        return;
      }
      this.offline = e;
    } finally {
      this.checking = false;
    }
  }

  private async signedOut(): Promise<void> {
    this.offline = null;
    // Read before the signed-out state clears the hint.
    if (wasSignedIn() && hasSessionWork()) await endStaleSession();
    session.email = null;
  }

  watch(): () => void {
    return watchSignOutElsewhere(() => {
      if (Boolean(session.email) === false) return;
      clearQuerySession();
      endSession(false);
    });
  }
  syncHint(): void {
    if (typeof session.email === "string") rememberSignedIn(true);
    if (session.email === null) rememberSignedIn(false);
  }
}
/** Starts the signed-in shell import after preparing its shared response contracts. */
export function loadAuthenticatedShell() {
  preloadResponseContracts();
  return import("$lib/shell/authenticated-shell.svelte");
}
