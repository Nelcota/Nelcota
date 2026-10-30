import { SessionError } from "../errors.js";
import { base64url, concatenate, fromBase64url, randomBytes, sha256, utf8 } from "./crypto.js";
import { sessionState } from "./state.js";

const KEY_BYTES = 32;
const KEY_ID_CHARS = 16;
const HEX_RADIX = 16;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_KEYRING_SIZE = 3;
const KEY_ID_BITS = 64;
const BASE64_GROUP_BYTES = 3;
const BASE64_GROUP_CHARS = 4;
/** Largest plaintext (UTF-8 JSON) a sealed record may carry. */
const MAX_STATE_BYTES = 65_536;
/** Longest envelope `seal` can produce; every store bound derives from it. */
export const MAX_SEALED_CHARS: number =
  "v2.".length +
  KEY_ID_CHARS +
  ".".length +
  Math.ceil(
    ((SALT_BYTES + IV_BYTES + MAX_STATE_BYTES + AUTH_TAG_BYTES) * BASE64_GROUP_CHARS) /
      BASE64_GROUP_BYTES,
  );
// Frozen wire constants: existing rows authenticate with these strings, so they
// keep their historical `nelcota-next` prefix and must never change.
const SEAL_V2_INFO = "nelcota-next/seal/v2";
const KEY_ID_INFO = "nelcota-next/key-id/v1";

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

/** Parse the bounded wire envelope before selecting or deriving a decryption key. */
function sealedEnvelope(sealed: string): { version: "v1" | "v2"; id: string; body: string } {
  if (sealed.length > MAX_SEALED_CHARS) throw new Error("size");
  const [version, id, body, extra] = sealed.split(".");
  if (
    (version !== "v1" && version !== "v2") ||
    id === undefined ||
    id === "" ||
    body === undefined ||
    body === "" ||
    extra !== undefined ||
    /^[A-Za-z0-9_-]+$/.test(body) === false
  )
    throw new Error("envelope");
  return { version, id, body };
}

function openedRecord(opened: ArrayBuffer): Record<string, unknown> {
  if (opened.byteLength > MAX_STATE_BYTES) throw new Error("size");
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
  /** HKDF-derived envelope id. Accepted when opening; a later release will write it
   * once every deployment reads it (this one does). */
  id: string;
  /** First 64 bits of SHA-256(raw key): still written by new seals so 0.1.x
   * instances (rolling deploys, rollbacks) can open them, and the HKDF info suffix
   * of every v2 row. */
  legacyId: string;
  /** Raw AES-GCM key for v1 rows; absent when v1 envelopes are refused. */
  key: CryptoKey | null;
  hkdf: CryptoKey;
}

export interface SealerOptions {
  /** Open legacy v1 envelopes (raw-key AES-GCM, no per-message salt). Default true;
   * deprecated: set false once every v1 row has expired or been resealed. */
  legacyEnvelopes?: boolean;
}

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
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
  return bytes;
}

async function sealingKey(bytes: Uint8Array<ArrayBuffer>, legacy: boolean): Promise<SealingKey> {
  const hkdf = await crypto.subtle.importKey("raw", bytes, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
  const [legacyId, derived, key] = await Promise.all([
    sha256(bytes),
    crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(KEY_ID_INFO) },
      hkdf,
      KEY_ID_BITS,
    ),
    legacy
      ? crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["decrypt"])
      : Promise.resolve(null),
  ]);
  const id = Array.from(new Uint8Array(derived), (byte) =>
    byte.toString(HEX_RADIX).padStart(2, "0"),
  ).join("");
  return { id, legacyId: legacyId.slice(0, KEY_ID_CHARS), key, hkdf };
}

/** Domain-separated AES-GCM; the primary key seals and the bounded keyring opens.
 * v2 derives a per-message AES key with HKDF-SHA-256 from a random 128-bit salt,
 * so no single key encrypts with random 96-bit nonces at scale. v1 still opens
 * unless `legacyEnvelopes` is false. Envelopes still carry the SHA-256-prefix key
 * id for 0.1.x readers; the HKDF-derived id is accepted too, ready for a later
 * release to switch writing to it.
 */
export class SessionSealer {
  readonly #keys: Map<string, SealingKey>;
  readonly #primary: SealingKey;
  private constructor(keys: Map<string, SealingKey>, primary: SealingKey) {
    this.#keys = keys;
    this.#primary = primary;
  }
  static async create(
    secrets: readonly string[],
    options: SealerOptions = {},
  ): Promise<SessionSealer> {
    if (secrets.length < 1 || secrets.length > MAX_KEYRING_SIZE)
      throw new SessionError("configuration", "Supply one to three session encryption keys");
    const keys = new Map<string, SealingKey>();
    let primary: SealingKey | undefined;
    for (const secret of secrets) {
      // oxlint-disable-next-line no-await-in-loop -- Validate the bounded keyring in order, preserving the primary key and first configuration failure.
      const owner = await sealingKey(secretBytes(secret), options.legacyEnvelopes !== false);
      if (keys.has(owner.id) || keys.has(owner.legacyId))
        throw new SessionError("configuration", "Duplicate session encryption key");
      keys.set(owner.id, owner);
      keys.set(owner.legacyId, owner);
      primary ??= owner;
    }
    if (primary === undefined)
      throw new SessionError("configuration", "Missing primary session key");
    return new SessionSealer(keys, primary);
  }
  async seal(state: SessionState | Record<string, unknown>, binding: string): Promise<string> {
    const data = utf8(JSON.stringify(state));
    if (data.length > MAX_STATE_BYTES)
      throw new SessionError("invalid_session", "Session state exceeds the storage limit");
    const salt = randomBytes(SALT_BYTES),
      iv = randomBytes(IV_BYTES);
    const key = await SessionSealer.#derive(this.#primary, salt, "encrypt");
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(binding) },
      key,
      data,
    );
    return `v2.${this.#primary.legacyId}.${base64url(concatenate(salt, iv, new Uint8Array(encrypted)))}`;
  }
  static async #derive(
    owner: SealingKey,
    salt: Uint8Array<ArrayBuffer>,
    usage: "encrypt" | "decrypt",
  ): Promise<CryptoKey> {
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: utf8(`${SEAL_V2_INFO}\0${owner.legacyId}`) },
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
      if (key === null) throw new Error("legacy envelope");
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
