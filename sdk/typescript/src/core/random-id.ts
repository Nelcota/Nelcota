/** Opaque random identifiers for coordination records (not secrets, not PKCE). */
import { base64UrlEncode } from "./jwt.js";

const ID_BYTES = 48;
/** Length of every `randomId()`: 48 random bytes in unpadded base64url. */
export const RANDOM_ID_CHARS = 64;

/** A 64-character base64url identifier from 48 random bytes. */
export function randomId(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}
