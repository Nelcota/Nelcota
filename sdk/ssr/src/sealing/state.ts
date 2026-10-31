import type { SessionState } from "./seal.js";

function nullableText(value: unknown): boolean {
  return value === null || typeof value === "string";
}
function oauthNonce(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value));
}
function requireBaseState(row: Record<string, unknown>): void {
  if (
    row["schema"] !== 1 ||
    nullableText(row["session"]) === false ||
    nullableText(row["pkce"]) === false ||
    (row["signupPkce"] !== undefined && nullableText(row["signupPkce"]) === false) ||
    oauthNonce(row["oauthState"]) === false ||
    typeof row["returnTo"] !== "string" ||
    Number.isSafeInteger(row["expiresAt"]) === false ||
    (row["expiresAt"] as number) <= Date.now()
  )
    throw new Error("state");
}
function requireLineage(row: Record<string, unknown>): void {
  if (
    row["lineage"] !== undefined &&
    (typeof row["lineage"] !== "string" || /^[a-f0-9]{64}$/.test(row["lineage"]) === false)
  )
    throw new Error("lineage");
  if (
    row["generation"] !== undefined &&
    (Number.isSafeInteger(row["generation"]) === false || (row["generation"] as number) < 1)
  )
    throw new Error("generation");
  if (row["superseded"] !== undefined && row["superseded"] !== true) throw new Error("superseded");
}

/** Validate authenticated state without discarding forward-compatible record fields. */
export function sessionState(row: Record<string, unknown>): SessionState {
  requireBaseState(row);
  requireLineage(row);
  return row as unknown as SessionState;
}
