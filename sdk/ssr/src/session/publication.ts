import { SessionError } from "../errors.js";
import type { AuthQueue } from "./actions.js";
import type { CookieWriter } from "./types.js";
import type { WriteState } from "./write-state.js";

const SECOND_IN_MS = 1_000;
function publishCookie(state: WriteState, cookies: CookieWriter, keep: boolean): void {
  try {
    const config = state.records.config;
    cookies.set(config.name, keep ? state.id : "", {
      httpOnly: true,
      secure: config.secure,
      sameSite: "lax",
      path: "/",
      maxAge:
        keep && state.state !== null
          ? Math.max(0, Math.floor((state.state.expiresAt - Date.now()) / SECOND_IN_MS))
          : 0,
    });
  } catch (cause) {
    throw new SessionError("session_store", "Session cookie publication failed", cause);
  }
}

async function isSuperseded(state: WriteState): Promise<boolean> {
  if (state.publication.cookieNeeded === false || state.generation === null) return false;
  const head = await state.records.head(state.lineage, undefined, state.lease);
  return head?.current !== state.key || head.generation !== state.generation;
}

async function publishTombstone(state: WriteState): Promise<void> {
  try {
    await state.lease.save(await state.records.tombstone(state.key, state.lineage));
  } catch (cause) {
    state.markPublicationFailed();
    throw new SessionError("session_store", "Session publication failed", cause);
  }
}
function keepCookie(state: WriteState): boolean {
  return state.state !== null && (state.state.session !== null || state.state.pkce !== null);
}

/** Recheck the lineage head after draining work, including redirect exceptions. */
export async function publishAcceptedSession(
  state: WriteState,
  queue: AuthQueue,
  cookies: CookieWriter,
): Promise<void> {
  state.stopAccepting();
  await queue.settle();
  if (state.publication.failed)
    throw new SessionError("session_store", "Session publication failed");
  const stale = await isSuperseded(state);
  if (stale && state.state !== null) await publishTombstone(state);
  if (state.publication.cookieNeeded && stale === false) {
    state.ensure();
    publishCookie(state, cookies, keepCookie(state));
  }
  if (
    state.publication.cookieNeeded === false &&
    state.clearPresented &&
    state.id !== state.input.existingId
  )
    publishCookie(state, cookies, false);
}
