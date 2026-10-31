import type { Json } from "../core/json-types.js";
/** Sessions and users as the server returns them, and where they are kept. */
import { isRecord, parseJson } from "../core/json.js";
import { SECOND_IN_MS } from "../core/runtime.js";

export interface User {
  id: string;
  email: string;
  email_confirmed_at: string | null;
  user_metadata: { [key: string]: Json | undefined };
  created_at: string;
  last_sign_in_at: string | null;
}

export interface Session {
  access_token: string;
  token_type: "bearer";
  /** Seconds the access token lives. */
  expires_in: number;
  /** Unix time (seconds) when the access token expires. */
  expires_at: number;
  refresh_token: string;
  user: User;
}

/**
 * Where the session is kept. Native `localStorage` also uses an IndexedDB
 * coordination journal; `sessionStorage` and custom adapters keep their own state.
 * a server keeps it per request (a cookie adapter) or in memory.
 */
export interface SessionStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** Keeps the session in this process only (the default outside browsers). */
export function memoryStorage(): SessionStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

export function isUser(value: unknown): value is User {
  if (isRecord(value) === false) return false;
  return (
    typeof value["id"] === "string" &&
    value["id"].length > 0 &&
    typeof value["email"] === "string" &&
    (value["email_confirmed_at"] === null || typeof value["email_confirmed_at"] === "string") &&
    typeof value["created_at"] === "string" &&
    (value["last_sign_in_at"] === null || typeof value["last_sign_in_at"] === "string") &&
    isRecord(value["user_metadata"])
  );
}

function validSessionLifetime(value: Record<string, unknown>): boolean {
  return (
    typeof value["expires_in"] === "number" &&
    Number.isSafeInteger(value["expires_in"]) &&
    value["expires_in"] >= 0 &&
    typeof value["expires_at"] === "number" &&
    Number.isSafeInteger(value["expires_at"]) &&
    value["expires_at"] >= 0
  );
}

/** Whether a value has the shape of a session (stored data is untrusted). */
export function isSession(value: unknown): value is Session {
  if (isRecord(value) === false) return false;
  return (
    typeof value["access_token"] === "string" &&
    value["access_token"].length > 0 &&
    typeof value["refresh_token"] === "string" &&
    value["refresh_token"].length > 0 &&
    value["token_type"] === "bearer" &&
    validSessionLifetime(value) &&
    isUser(value["user"])
  );
}

export function parseSession(text: string | null): Session | null {
  if (text === null) return null;
  try {
    const value: unknown = parseJson(text);
    return isSession(value) ? value : null;
  } catch {
    return null;
  }
}

/** Seconds until the access token expires (negative when it has). */
export function secondsLeft(session: Session, now: number = Date.now()): number {
  return session.expires_at - now / SECOND_IN_MS;
}
