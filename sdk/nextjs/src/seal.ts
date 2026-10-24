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
}
const maxBytes = 65536;

export function newSessionId(): string { return randomBytes(32).toString('base64url'); }
export function sessionKey(id: string, namespace = ''): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id) || Buffer.from(id, 'base64url').toString('base64url') !== id) return null;
  return createHash('sha256').update(namespace).update('\0').update(id).digest('hex');
}

/** Domain-separated AES-GCM; the primary key seals and the bounded keyring opens. */
export class SessionSealer {
  readonly #keys: Map<string, { key: webcrypto.CryptoKey; id: string }>;
  readonly #primary: { key: webcrypto.CryptoKey; id: string };
  private constructor(keys: Map<string, { key: webcrypto.CryptoKey; id: string }>, primary: { key: webcrypto.CryptoKey; id: string }) {
    this.#keys = keys; this.#primary = primary;
  }
  static async create(secrets: readonly string[]): Promise<SessionSealer> {
    if (secrets.length < 1 || secrets.length > 3) throw new SessionError('configuration', 'Supply one to three session encryption keys');
    const keys = new Map<string, { key: webcrypto.CryptoKey; id: string }>();
    for (const secret of secrets) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new SessionError('configuration', 'Session keys must be 32 random bytes in canonical base64url');
      const bytes = Buffer.from(secret, 'base64url');
      if (bytes.length !== 32 || bytes.toString('base64url') !== secret) throw new SessionError('configuration', 'Invalid session encryption key');
      const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      if (keys.has(id)) throw new SessionError('configuration', 'Duplicate session encryption key');
      const key = await webcrypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      keys.set(id, { id, key });
    }
    const primary = keys.values().next().value;
    if (!primary) throw new SessionError('configuration', 'Missing primary session key');
    return new SessionSealer(keys, primary);
  }
  async seal(state: SessionState, binding: string): Promise<string> {
    const data = Buffer.from(JSON.stringify(state));
    if (data.length > maxBytes) throw new SessionError('invalid_session', 'Session state exceeds the storage limit');
    const iv = randomBytes(12);
    const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(binding) }, this.#primary.key, data);
    return `v1.${this.#primary.id}.${Buffer.concat([iv, Buffer.from(encrypted)]).toString('base64url')}`;
  }
  async open(sealed: string, binding: string): Promise<SessionState> {
    try {
      if (sealed.length > 90000) throw new Error('size');
      const [version, id, body, extra] = sealed.split('.');
      if (version !== 'v1' || !id || !body || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('envelope');
      const owner = this.#keys.get(id), bytes = Buffer.from(body, 'base64url');
      if (!owner || bytes.length < 28 || bytes.toString('base64url') !== body) throw new Error('key');
      const opened = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: Buffer.from(binding) }, owner.key, bytes.subarray(12));
      if (opened.byteLength > maxBytes) throw new Error('size');
      const state: unknown = JSON.parse(Buffer.from(opened).toString('utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('shape');
      const row = state as Record<string, unknown>;
      if (row['schema'] !== 1 || !(row['session'] === null || typeof row['session'] === 'string') || !(row['pkce'] === null || typeof row['pkce'] === 'string') || !(row['oauthState'] === null || (typeof row['oauthState'] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row['oauthState']))) || typeof row['returnTo'] !== 'string' || !Number.isSafeInteger(row['expiresAt']) || (row['expiresAt'] as number) <= Date.now()) throw new Error('state');
      return row as unknown as SessionState;
    } catch (cause) { throw new SessionError('invalid_session', 'Session state could not be verified', cause); }
  }
}
