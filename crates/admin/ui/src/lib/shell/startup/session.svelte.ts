import { preloadResponseContracts } from "$lib/contracts/responses";
import { clearQuerySession } from "$lib/resources/query-client";
import { session } from "$lib/resources/session.svelte";
import { api, ApiError } from "$lib/transport/api";

import { rememberSignedIn, watchSignOutElsewhere } from "../prefetch.js";
const HTTP_UNAUTHORIZED = 401;

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
        this.offline = null;
        session.email = null;
        return;
      }
      this.offline = e;
    } finally {
      this.checking = false;
    }
  }

  watch(): () => void {
    return watchSignOutElsewhere(() => {
      if (Boolean(session.email) === false) return;
      clearQuerySession();
      session.expired = false;
      session.email = null;
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
