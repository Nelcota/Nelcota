/** PKCE (RFC 7636) with S256, on Web Crypto. */

import { base64UrlEncode } from "../core/jwt.js";
const VERIFIER_BYTES = 48;

/** 64 characters from 48 random bytes (the RFC allows 43 to 128). */
export function createVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES)));
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
