import { SessionError } from "../../errors.js";
import { MAX_SEALED_CHARS } from "../../sealing/seal.js";
import type { StoredSession } from "../../store.js";

// Writes use the tightest bound `seal` can produce. The deployed schema keeps its
// CHECK (octet_length(sealed) <= 131072) as an outer bound, and reads accept rows up
// to it so that an oversize row opens as "no session" rather than a store failure.
const MAX_STORED_ROW_CHARS = 131_072;
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
    row["sealed"].length > MAX_STORED_ROW_CHARS ||
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
    value.sealed.length > MAX_SEALED_CHARS
  )
    throw new SessionError("invalid_session", "Invalid bounded session state");
}
