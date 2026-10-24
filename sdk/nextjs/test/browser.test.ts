import { afterEach, expect, it, vi } from 'vitest';
import { refreshSession } from '../src/browser.js';
afterEach(() => vi.unstubAllGlobals());
function browser() {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('location', { origin: 'https://app.test' }); vi.stubGlobal('navigator', {}); vi.stubGlobal('fetch', fetch);
  return fetch;
}
it('uses a same-origin bounded POST without JavaScript tokens', async () => {
  const fetch = browser();
  expect((await refreshSession()).status).toBe(204);
  expect(String(fetch.mock.calls[0]![0])).toBe('https://app.test/auth/session/refresh');
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
});
it('refuses foreign/ambiguous refresh endpoints before fetch', async () => {
  const fetch = browser();
  for (const endpoint of ['https://evil.test', '//evil.test', '/.//evil.test', '/auth\\refresh', '/auth/refresh#secret', '/auth/refresh\n']) await expect(refreshSession({ endpoint })).rejects.toBeInstanceOf(TypeError);
  expect(fetch).not.toHaveBeenCalled();
});
it('validates finite deadlines and passes cancellation to Web Locks', async () => {
  const fetch = browser();
  for (const timeout of [NaN, Infinity, -1, 0, 30001]) await expect(refreshSession({ timeout })).rejects.toBeInstanceOf(TypeError);
  const locks = { request: vi.fn(async (_key, options, work) => { options.signal.throwIfAborted(); return work(); }) };
  vi.stubGlobal('navigator', { locks });
  const controller = new AbortController(); controller.abort();
  await expect(refreshSession({ signal: controller.signal })).rejects.toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
});
