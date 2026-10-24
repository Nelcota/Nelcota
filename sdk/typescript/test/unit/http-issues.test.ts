import { afterEach, expect, it, vi } from 'vitest';
import { createClient, NelcotaUsageError } from '../../src/index.js';
import { parseRetryAfter } from '../../src/core/http.js';
import { empty, mockFetch } from './helpers.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(['1.5', '-1', '1, 2', '2026-10-24', '99999999999999999999'])('ignores invalid Retry-After %s (#142)', value => expect(parseRetryAfter(value)).toBeUndefined());
it('accepts integer delay and HTTP dates (#142)', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('1994-11-06T08:49:30Z')); expect(parseRetryAfter('10')).toBe(10);
  for (const value of ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994']) expect(parseRetryAfter(value)).toBe(7);
});
it.each(['https://api.example.com/?', 'https://api.example.com/#'])('refuses empty URL delimiters %s (#142)', url => {
  expect(() => createClient(url)).toThrow(NelcotaUsageError); expect(() => createClient(new URL(url))).toThrow(NelcotaUsageError);
});
it('reports invalid HTTP headers as usage errors before fetch (#142)', async () => {
  const mock = mockFetch(empty()); const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try {
    await expect(client.storage.from('assets').open('file', { ifNoneMatch: '"a"\r\nX-Evil: 1' })).rejects.toBeInstanceOf(NelcotaUsageError);
    await expect(client.storage.from('assets').upload('file', 'body', { contentType: 'text/plain; name=日本' })).rejects.toBeInstanceOf(NelcotaUsageError); expect(mock.calls).toHaveLength(0);
  } finally { client.dispose(); }
});
it('retains HTTP status when error body reading fails (#142)', async () => {
  const fetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('body reset')); } }), { status: 404 }));
  const client = createClient('https://api.example.com', { fetch, auth: { autoRefresh: false } });
  try { const result = await client.storage.listBuckets(); expect(result.error).toMatchObject({ status: 404, code: 'not_found' }); expect(fetch).toHaveBeenCalledTimes(1); } finally { client.dispose(); }
});
it('ends timeout at headers for a raw stream (#135)', async () => {
  let signal: AbortSignal | null | undefined;
  const client = createClient('https://api.example.com', { timeout: 20, fetch: async (_url, init) => { signal = init?.signal; return new Response('object'); }, auth: { autoRefresh: false } });
  try { const result = await client.storage.from('assets').open('file', { timeout: 20 }); expect(result.error).toBeNull(); await new Promise(resolve => setTimeout(resolve, 40)); expect(signal?.aborted).toBe(false); expect(await result.data?.text()).toBe('object'); } finally { client.dispose(); }
});
it('interprets obsolete HTTP dates as UTC independently of the host timezone (#142)', () => {
  vi.stubEnv('TZ', 'America/Sao_Paulo');
  vi.useFakeTimers(); vi.setSystemTime(new Date('1994-11-06T08:49:30Z'));
  try { expect(parseRetryAfter('Sun Nov  6 08:49:37 1994')).toBe(7); }
  finally { vi.unstubAllEnvs(); }
});
