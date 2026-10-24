import { describe, expect, it } from 'vitest';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { DevelopmentSessionStore } from '../src/memory-store.js';
import { newSessionId, sessionKey, SessionSealer, type SessionState } from '../src/seal.js';

const state = (): SessionState => ({ schema: 1, session: 'private-session', pkce: 'private-pkce', oauthState: null, returnTo: '/', expiresAt: Date.now() + 60000 });
describe('session envelope', () => {
  it('generates bounded opaque ids and hashes keys', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newSessionId()));
    expect(ids.size).toBe(100);
    for (const id of ids) { expect(id).toHaveLength(43); expect(sessionKey(id)).toMatch(/^[a-f0-9]{64}$/); }
    for (const id of ['', '../session', 'a'.repeat(44), 'a'.repeat(42) + '!']) expect(sessionKey(id)).toBeNull();
  });
  it('authenticates identity/binding, hides plaintext and supports key rotation', async () => {
    const first = randomBytes(32).toString('base64url'), second = randomBytes(32).toString('base64url');
    const old = await SessionSealer.create([first]), rotated = await SessionSealer.create([second, first]);
    const sealed = await old.seal(state(), 'app/project/session');
    expect(sealed).not.toContain('private');
    expect((await rotated.open(sealed, 'app/project/session')).pkce).toBe('private-pkce');
    await expect(rotated.open(sealed, 'other-app/session')).rejects.toMatchObject({ code: 'invalid_session' });
    await expect(rotated.open(sealed.slice(0, -5) + 'aaaaa', 'app/project/session')).rejects.toMatchObject({ code: 'invalid_session' });
    const newValue = await rotated.seal(state(), 'app/project/session');
    await expect(old.open(newValue, 'app/project/session')).rejects.toMatchObject({ code: 'invalid_session' });
  });
  it('refuses weak keys, oversize state and expired state', async () => {
    for (const keys of [[], ['short'], Array(4).fill('a'.repeat(43)), ['='.repeat(43)]]) await expect(SessionSealer.create(keys)).rejects.toMatchObject({ code: 'configuration' });
    const seal = await SessionSealer.create([randomBytes(32).toString('base64url')]);
    await expect(seal.seal({ ...state(), session: 'x'.repeat(70000) }, 'binding')).rejects.toMatchObject({ code: 'invalid_session' });
    const expired = await seal.seal({ ...state(), expiresAt: 1 }, 'binding');
    await expect(seal.open(expired, 'binding')).rejects.toMatchObject({ code: 'invalid_session' });
  });
});
describe('development ownership', () => {
  it('serializes one session, preserves another and closes old writers', async () => {
    const store = new DevelopmentSessionStore();
    let release!: () => void, oldLease: Parameters<Parameters<typeof store.exclusive>[1]>[0] | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const order: number[] = [];
    const first = store.exclusive('one', async lease => { oldLease = lease; order.push(1); await held; await lease.save({ sealed: 'new', expiresAt: Date.now() + 60000 }); order.push(2); });
    const second = store.exclusive('one', async lease => { expect((await lease.load())?.sealed).toBe('new'); order.push(3); });
    await store.exclusive('two', async lease => { await lease.save({ sealed: 'other', expiresAt: Date.now() + 60000 }); });
    release(); await Promise.all([first, second]); expect(order).toEqual([1, 2, 3]);
    await expect(oldLease?.remove()).rejects.toMatchObject({ code: 'closed_context' });
    expect((await store.read('two'))?.sealed).toBe('other');
  });
  it('rotates a lease to a fresh key and removes the previous row', async () => {
    const store = new DevelopmentSessionStore(), row = { sealed: 'one', expiresAt: Date.now() + 60000 };
    await store.exclusive('one', lease => lease.save(row));
    await store.exclusive('one', async lease => { await lease.rotate('two'); expect(await lease.load()).toBeNull(); await lease.save(row); });
    expect(await store.read('one')).toBeNull(); expect(await store.read('two')).toEqual(row);
  });
  it('bounds storage and does not retain a failed owner', async () => {
    const store = new DevelopmentSessionStore(1), row = { sealed: 'one', expiresAt: Date.now() + 60000 };
    await expect(store.exclusive('one', async lease => { await lease.save(row); throw new Error('failure'); })).rejects.toThrow('failure');
    await expect(store.exclusive('two', async lease => lease.save(row))).rejects.toMatchObject({ code: 'session_capacity' });
    await store.exclusive('one', lease => lease.remove());
    await store.exclusive('two', lease => lease.save(row));
    expect(await store.read('two')).toEqual(row);
  });
});
describe('sealed format', () => {
  it('seals v2 with a fresh per-message salt and still opens v1 rows', async () => {
    const secret = randomBytes(32).toString('base64url'), sealer = await SessionSealer.create([secret]);
    const first = await sealer.seal(state(), 'binding'), second = await sealer.seal(state(), 'binding');
    expect(first).toMatch(/^v2\.[a-f0-9]{16}\./);
    const salt = (value: string) => Buffer.from(value.split('.')[2]!, 'base64url').subarray(0, 16).toString('hex');
    expect(salt(first)).not.toBe(salt(second));
    expect((await sealer.open(first, 'binding')).session).toBe('private-session');
    await expect(sealer.open(first, 'other')).rejects.toMatchObject({ code: 'invalid_session' });
    const body = Buffer.from(first.split('.')[2]!, 'base64url'); body[0] = body[0]! ^ 1;
    await expect(sealer.open(`v2.${first.split('.')[1]}.${body.toString('base64url')}`, 'binding')).rejects.toMatchObject({ code: 'invalid_session' });
    // Previous format: AES-GCM directly under the primary key, iv || ciphertext.
    const bytes = Buffer.from(secret, 'base64url'), iv = randomBytes(12);
    const raw = await webcrypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('binding') }, raw, Buffer.from(JSON.stringify(state())));
    const legacy = `v1.${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.${Buffer.concat([iv, Buffer.from(encrypted)]).toString('base64url')}`;
    expect((await sealer.open(legacy, 'binding')).pkce).toBe('private-pkce');
    await expect(sealer.open(legacy, 'other')).rejects.toMatchObject({ code: 'invalid_session' });
    await expect(sealer.open(legacy.replace(/^v1/, 'v2'), 'binding')).rejects.toMatchObject({ code: 'invalid_session' });
    await expect(sealer.open(first.replace(/^v2/, 'v3'), 'binding')).rejects.toMatchObject({ code: 'invalid_session' });
  });
});
