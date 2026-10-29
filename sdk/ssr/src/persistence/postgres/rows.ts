import { SessionError } from "../../errors.js";
import type { StoredSession } from "../../store.js";

const MAX_SEALED_SESSION_CHARS = 131_072;
export function keyCheck(key: string): void {
  if (/^[a-f0-9]{64}$/.test(key) === false)
    throw new SessionError("invalid_session", "Invalid session key");
}
export function stored(row: Record<string, unknown> | undefined): StoredSession | null {
  if (row == null) return null;
  const raw = row["expires_at"];
  if (
    typeof raw !== "number" &&
    (typeof raw === "string" && /^(0|[1-9][0-9]{0,15})$/.test(raw)) === false
  )
    throw new SessionError("session_store", "Invalid session expiry");
  const expiresAt = Number(raw);
  if (
    typeof row["sealed"] !== "string" ||
    row["sealed"].length > MAX_SEALED_SESSION_CHARS ||
    Number.isSafeInteger(expiresAt) === false
  )
    throw new SessionError("session_store", "Invalid session store response");
  if (expiresAt <= Date.now()) return null;
  return { sealed: row["sealed"], expiresAt };
}
export function requireBoundedState(value: StoredSession): void {
  if (
    Number.isSafeInteger(value.expiresAt) === false ||
    value.expiresAt <= Date.now() ||
    value.sealed.length > MAX_SEALED_SESSION_CHARS
  )
    throw new SessionError("invalid_session", "Invalid bounded session state");
}
