import { SessionError } from "../errors.js";
import { base64url, concatenate, fromBase64url, randomBytes, sha256, utf8 } from "./crypto.js";
import { sealedEnvelope } from "./envelope.js";
import { sessionState } from "./state.js";

const KEY_BYTES = 32;
const KEY_ID_CHARS = 16;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_KEYRING_SIZE = 3;

export interface SessionState {
  schema: 1;
  session: string | null;
  pkce: string | null;
  oauthState: string | null;
  returnTo: string;
  expiresAt: number;
  /** Store key of this browser's lineage head record (see context.ts). */
  lineage?: string;
  /** Lineage generation this identity was published as; set on session-bearing states. */
  generation?: number;
  /** A retired key: no credentials, kept only to link delayed requests to the lineage. */
  superseded?: true;
}
const maxBytes = 65536;

function openedRecord(opened: ArrayBuffer): Record<string, unknown> {
  if (opened.byteLength > maxBytes) throw new Error("size");
  const state: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened));
  if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("shape");
  return state as Record<string, unknown>;
}

export function newSessionId(): string {
  return base64url(randomBytes(KEY_BYTES));
}
export async function sessionKey(id: string, namespace = ""): Promise<string | null> {
  if (/^[A-Za-z0-9_-]{43}$/.test(id) === false) return null;
  try {
    fromBase64url(id);
  } catch {
    return null;
  }
  return await sha256(`${namespace}\0${id}`);
}

interface SealingKey {
  id: string;
  key: CryptoKey;
  hkdf: CryptoKey;
}

/** Domain-separated AES-GCM; the primary key seals and the bounded keyring opens.
 * v2 derives a per-message AES key with HKDF-SHA-256 from a random 128-bit salt,
 * so no single key encrypts with random 96-bit nonces at scale. v1 still opens.
 */
export class SessionSealer {
  readonly #keys: Map<string, SealingKey>;
  readonly #primary: SealingKey;
  private constructor(keys: Map<string, SealingKey>, primary: SealingKey) {
    this.#keys = keys;
    this.#primary = primary;
  }
  static async create(secrets: readonly string[]): Promise<SessionSealer> {
    if (secrets.length < 1 || secrets.length > MAX_KEYRING_SIZE)
      throw new SessionError("configuration", "Supply one to three session encryption keys");
    const keys = new Map<string, SealingKey>();
    for (const secret of secrets) {
      if (/^[A-Za-z0-9_-]{43}$/.test(secret) === false)
        throw new SessionError(
          "configuration",
          "Session keys must be 32 random bytes in canonical base64url",
        );
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = fromBase64url(secret);
      } catch (cause) {
        throw new SessionError("configuration", "Invalid session encryption key", cause);
      }
      if (bytes.length !== KEY_BYTES || base64url(bytes) !== secret)
        throw new SessionError("configuration", "Invalid session encryption key");
      // oxlint-disable-next-line no-await-in-loop -- Validate the bounded keyring in order, preserving the primary key and first configuration failure.
      const id = (await sha256(bytes)).slice(0, KEY_ID_CHARS);
      if (keys.has(id)) throw new SessionError("configuration", "Duplicate session encryption key");
      // oxlint-disable-next-line no-await-in-loop -- Validate the bounded keyring in order, preserving the primary key and first configuration failure.
      const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
        "decrypt",
      ]);
      // oxlint-disable-next-line no-await-in-loop -- Validate the bounded keyring in order, preserving the primary key and first configuration failure.
      const hkdf = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
      keys.set(id, { id, key, hkdf });
    }
    const primary = keys.values().next().value;
    if (primary == null) throw new SessionError("configuration", "Missing primary session key");
    return new SessionSealer(keys, primary);
  }
  async seal(state: SessionState | Record<string, unknown>, binding: string): Promise<string> {
    const data = utf8(JSON.stringify(state));
    if (data.length > maxBytes)
      throw new SessionError("invalid_session", "Session state exceeds the storage limit");
    const salt = randomBytes(SALT_BYTES),
      iv = randomBytes(IV_BYTES);
    const key = await SessionSealer.#derive(this.#primary, salt, "encrypt");
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(binding) },
      key,
      data,
    );
    return `v2.${this.#primary.id}.${base64url(concatenate(salt, iv, new Uint8Array(encrypted)))}`;
  }
  static async #derive(
    owner: SealingKey,
    salt: Uint8Array<ArrayBuffer>,
    usage: "encrypt" | "decrypt",
  ): Promise<CryptoKey> {
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: utf8(`nelcota-next/seal/v2\0${owner.id}`) },
      owner.hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      [usage],
    );
  }
  async open(sealed: string, binding: string): Promise<SessionState> {
    const row = await this.openRecord(sealed, binding);
    try {
      return sessionState(row);
    } catch (cause) {
      throw new SessionError("invalid_session", "Session state could not be verified", cause);
    }
  }
  /** Authenticated JSON object; callers validate its shape. */
  async openRecord(sealed: string, binding: string): Promise<Record<string, unknown>> {
    try {
      const { version, id, body } = sealedEnvelope(sealed);
      const owner = this.#keys.get(id),
        bytes = fromBase64url(body),
        salt = version === "v2" ? SALT_BYTES : 0;
      if (
        owner == null ||
        bytes.length < salt + IV_BYTES + AUTH_TAG_BYTES ||
        base64url(bytes) !== body
      )
        throw new Error("key");
      const key =
        version === "v2"
          ? await SessionSealer.#derive(owner, bytes.subarray(0, salt), "decrypt")
          : owner.key;
      const opened = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.subarray(salt, salt + IV_BYTES),
          additionalData: utf8(binding),
        },
        key,
        bytes.subarray(salt + IV_BYTES),
      );
      return openedRecord(opened);
    } catch (cause) {
      throw new SessionError("invalid_session", "Session state could not be verified", cause);
    }
  }
}
