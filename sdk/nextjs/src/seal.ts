import 'server-only';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { SessionError } from './errors.js';

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

export function newSessionId(): string { return randomBytes(32).toString('base64url'); }
export function sessionKey(id: string, namespace = ''): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id) || Buffer.from(id, 'base64url').toString('base64url') !== id) return null;
  return createHash('sha256').update(namespace).update('\0').update(id).digest('hex');
}

interface SealingKey { id: string; key: webcrypto.CryptoKey; hkdf: webcrypto.CryptoKey }

/** Domain-separated AES-GCM; the primary key seals and the bounded keyring opens.
 * v2 derives a per-message AES key with HKDF-SHA-256 from a random 128-bit salt,
 * so no single key encrypts with random 96-bit nonces at scale. v1 still opens.
 */
export class SessionSealer {
  readonly #keys: Map<string, SealingKey>;
  readonly #primary: SealingKey;
  private constructor(keys: Map<string, SealingKey>, primary: SealingKey) {
    this.#keys = keys; this.#primary = primary;
  }
  static async create(secrets: readonly string[]): Promise<SessionSealer> {
    if (secrets.length < 1 || secrets.length > 3) throw new SessionError('configuration', 'Supply one to three session encryption keys');
    const keys = new Map<string, SealingKey>();
    for (const secret of secrets) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new SessionError('configuration', 'Session keys must be 32 random bytes in canonical base64url');
      const bytes = Buffer.from(secret, 'base64url');
      if (bytes.length !== 32 || bytes.toString('base64url') !== secret) throw new SessionError('configuration', 'Invalid session encryption key');
      const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      if (keys.has(id)) throw new SessionError('configuration', 'Duplicate session encryption key');
      const key = await webcrypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['decrypt']);
      const hkdf = await webcrypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
      keys.set(id, { id, key, hkdf });
    }
    const primary = keys.values().next().value;
    if (!primary) throw new SessionError('configuration', 'Missing primary session key');
    return new SessionSealer(keys, primary);
  }
  async seal(state: SessionState | Record<string, unknown>, binding: string): Promise<string> {
    const data = Buffer.from(JSON.stringify(state));
    if (data.length > maxBytes) throw new SessionError('invalid_session', 'Session state exceeds the storage limit');
    const salt = randomBytes(16), iv = randomBytes(12);
    const key = await SessionSealer.#derive(this.#primary, salt, 'encrypt');
    const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(binding) }, key, data);
    return `v2.${this.#primary.id}.${Buffer.concat([salt, iv, Buffer.from(encrypted)]).toString('base64url')}`;
  }
  static async #derive(owner: SealingKey, salt: Buffer<ArrayBuffer>, usage: 'encrypt' | 'decrypt'): Promise<webcrypto.CryptoKey> {
    return webcrypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: Buffer.from(`nelcota-next/seal/v2\0${owner.id}`) }, owner.hkdf, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }
  async open(sealed: string, binding: string): Promise<SessionState> {
    const row = await this.openRecord(sealed, binding);
    try {
      if (row['schema'] !== 1 || !(row['session'] === null || typeof row['session'] === 'string') || !(row['pkce'] === null || typeof row['pkce'] === 'string') || !(row['oauthState'] === null || (typeof row['oauthState'] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row['oauthState']))) || typeof row['returnTo'] !== 'string' || !Number.isSafeInteger(row['expiresAt']) || (row['expiresAt'] as number) <= Date.now()) throw new Error('state');
      if (row['lineage'] !== undefined && (typeof row['lineage'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['lineage']))) throw new Error('lineage');
      if (row['generation'] !== undefined && (!Number.isSafeInteger(row['generation']) || (row['generation'] as number) < 1)) throw new Error('generation');
      if (row['superseded'] !== undefined && row['superseded'] !== true) throw new Error('superseded');
      return row as unknown as SessionState;
    } catch (cause) { throw new SessionError('invalid_session', 'Session state could not be verified', cause); }
  }
  /** Authenticated JSON object; callers validate its shape. */
  async openRecord(sealed: string, binding: string): Promise<Record<string, unknown>> {
    try {
      if (sealed.length > 90000) throw new Error('size');
      const [version, id, body, extra] = sealed.split('.');
      if ((version !== 'v1' && version !== 'v2') || !id || !body || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('envelope');
      const owner = this.#keys.get(id), bytes = Buffer.from(body, 'base64url'), salt = version === 'v2' ? 16 : 0;
      if (!owner || bytes.length < salt + 28 || bytes.toString('base64url') !== body) throw new Error('key');
      const key = version === 'v2' ? await SessionSealer.#derive(owner, bytes.subarray(0, salt), 'decrypt') : owner.key;
      const opened = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(salt, salt + 12), additionalData: Buffer.from(binding) }, key, bytes.subarray(salt + 12));
      if (opened.byteLength > maxBytes) throw new Error('size');
      const state: unknown = JSON.parse(Buffer.from(opened).toString('utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('shape');
      return state as Record<string, unknown>;
    } catch (cause) { throw new SessionError('invalid_session', 'Session state could not be verified', cause); }
  }
}
