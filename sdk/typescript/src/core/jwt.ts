/**
 * Reading (never verifying) JWT payloads. The server verifies every token;
 * the client only looks at `role` and `exp` to refuse obvious mistakes and to
 * schedule refreshes.
 */

import { NelcotaUsageError } from './errors.js';

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): string {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface JwtPayload {
  role?: unknown;
  exp?: unknown;
  sub?: unknown;
  [claim: string]: unknown;
}

/** The payload of a JWT, or `null` when the text is not one. */
export function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload: unknown = JSON.parse(base64UrlDecode(parts[1]));
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as JwtPayload)
      : null;
  } catch {
    return null;
  }
}

export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

let lastChecked: string | undefined;

/**
 * Refuses a `service_role` token in a browser: it bypasses RLS, so anyone who
 * opens the page could read and change every row. It belongs on a server.
 */
export function assertTokenAllowed(token: string, browser: boolean = isBrowser()): void {
  const scope = globalThis as typeof globalThis & { WorkerGlobalScope?: new (...args: never[]) => object };
  const worker = typeof scope.WorkerGlobalScope === 'function' && globalThis instanceof scope.WorkerGlobalScope;
  if ((!browser && !worker) || token === lastChecked) return;
  if (decodeJwt(token)?.role === 'service_role') {
    throw new NelcotaUsageError(
      'A service_role token bypasses RLS and must never reach a browser. Use it only on a server.',
    );
  }
  lastChecked = token;
}
