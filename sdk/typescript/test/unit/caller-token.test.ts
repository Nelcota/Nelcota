import { describe, expect, it, vi } from 'vitest';
import { createClient, memoryStorage, type AuthEvent } from '../../src/index.js';
import { createAuthClient, type AuthClientOptions } from '../../src/auth/index.js';
import { json, mockFetch, session } from './helpers.js';

const url = 'https://api.example.com';
const factories = [
  ['combined', (options: AuthClientOptions) => createClient(url, options).auth],
  ['standalone', (options: AuthClientOptions) => createAuthClient(url, options)],
] as const;
for (const [name, create] of factories) {
  describe(`${name} caller-owned auth token`, () => {
    for (const asyncSource of [false, true]) {
      for (const update of [false, true]) {
        it(`uses the ${asyncSource ? 'async' : 'sync'} token for ${update ? 'updateUser' : 'getUser'} without storing a session`, async () => {
          const user = session().user;
          const source = vi.fn(() => asyncSource ? Promise.resolve('caller-token') : 'caller-token');
          const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
          const mock = mockFetch(json(user));
          const auth = create({ fetch: mock.fetch, accessToken: source, auth: { storage } });
          const events: AuthEvent[] = [];
          auth.onChange(event => events.push(event));
          try {
            const result = await (update ? auth.updateUser({ data: { name: 'Ana' } }) : auth.getUser());
            expect(result.error).toBeNull(); expect(result.data).toEqual(user);
            expect(source).toHaveBeenCalledTimes(1); expect(mock.calls).toHaveLength(1);
            expect(mock.calls[0].headers.get('authorization')).toBe('Bearer caller-token');
            expect(mock.calls[0].method).toBe(update ? 'PUT' : 'GET');
            expect(mock.calls[0].url.pathname).toBe('/auth/v1/user');
            expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
            expect(storage.removeItem).not.toHaveBeenCalled(); expect(events).toEqual([]);
          } finally { auth.dispose(); }
        });
      }
    }
    it('never falls back to a stored session when the caller source returns null', async () => {
      const storage = memoryStorage(), mock = mockFetch(json(session().user));
      const auth = create({ fetch: mock.fetch, accessToken: async () => null, auth: { storage, autoRefresh: false } });
      try {
        await auth.setSession(session());
        const before = await storage.getItem('nelcota.api.example.com.session');
        expect((await auth.getUser()).error?.code).toBe('session_missing');
        expect((await auth.updateUser({ data: { name: 'Ana' } })).error?.code).toBe('session_missing');
        expect(mock.calls).toHaveLength(0); expect(await storage.getItem('nelcota.api.example.com.session')).toBe(before);
      } finally { auth.dispose(); }
    });
    it('uses the caller identity instead of a different stored session without updating it', async () => {
      const storage = memoryStorage(), mock = mockFetch(json({ ...session().user, id: 'caller-user' }));
      const auth = create({ fetch: mock.fetch, accessToken: () => 'caller-token', auth: { storage, autoRefresh: false } });
      try {
        await auth.setSession(session());
        const before = await storage.getItem('nelcota.api.example.com.session');
        expect((await auth.getUser()).data?.id).toBe('caller-user');
        expect(mock.calls[0].headers.get('authorization')).toBe('Bearer caller-token');
        expect(await storage.getItem('nelcota.api.example.com.session')).toBe(before);
      } finally { auth.dispose(); }
    });
    it('allows cancelling a token wait without sending HTTP', async () => {
      let started!: () => void, release!: (value: string) => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      const pending = new Promise<string>(resolve => { release = resolve; });
      const mock = mockFetch(json(session().user));
      const auth = create({ fetch: mock.fetch, accessToken: () => { started(); return pending; } });
      const abort = new AbortController();
      try {
        const reading = auth.getUser({ signal: abort.signal });
        await entered; abort.abort(); expect((await reading).error?.code).toBe('aborted');
        release('caller-token'); await Promise.resolve(); expect(mock.calls).toHaveLength(0);
      } finally { release('caller-token'); auth.dispose(); }
    });
    it('keeps source failures observable without HTTP', async () => {
      const failure = new Error('caller source failed'), mock = mockFetch(json(session().user));
      const auth = create({ fetch: mock.fetch, accessToken: async () => { throw failure; } });
      try { await expect(auth.getUser()).rejects.toBe(failure); expect(mock.calls).toHaveLength(0); }
      finally { auth.dispose(); }
    });
    it('keeps HTTP timeout and user response validation', async () => {
      const mock = mockFetch(json({ id: 'incomplete' }));
      const auth = create({ fetch: mock.fetch, accessToken: () => 'caller-token' });
      try { expect((await auth.getUser({ timeout: 100 })).error?.code).toBe('invalid_response'); }
      finally { auth.dispose(); }
      const slow = create({ accessToken: () => 'caller-token', retries: 0, fetch: async (_url, init) => {
        await new Promise<void>((_resolve, reject) => {
          if (init?.signal?.aborted) { reject(init.signal.reason); return; }
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
        return json(session().user);
      } });
      try { expect((await slow.getUser({ timeout: 20 })).error?.code).toBe('timeout'); }
      finally { slow.dispose(); }
    });
  });
}
