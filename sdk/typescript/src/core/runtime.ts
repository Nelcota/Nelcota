/** Runtime facts shared across features: time units, environment and random ids. */

export const SECOND_IN_MS = 1_000;
/** The largest delay `setTimeout` accepts (2^31 - 1 ms); longer delays fire at once. */
export const MAX_TIMER_IN_MS = 2_147_483_647;

/** A page with a DOM (not a worker and not a server). */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** A Web or Service Worker global. */
export function isWorkerScope(): boolean {
  const scope = (globalThis as { WorkerGlobalScope?: abstract new () => unknown })
    .WorkerGlobalScope;
  return typeof scope === "function" && globalThis instanceof scope;
}

/** Unpadded base64url, as used by JWT segments, PKCE and coordination ids. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const ID_BYTES = 48;
/** Length of every `randomId()`: 48 random bytes in unpadded base64url. */
export const RANDOM_ID_CHARS = 64;

/** An opaque 64-character base64url identifier for coordination records (not a secret, not PKCE). */
export function randomId(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}
