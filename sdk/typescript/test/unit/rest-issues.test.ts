import { afterEach, expect, it, vi } from 'vitest';
import { createClient } from '../../src/index.js';
import { json, mockFetch } from './helpers.js';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each(['single', 'maybeSingle'] as const)('aligns %s query string/status (#141)', async mode => {
  const mock = mockFetch(json([{ id: 1 }, { id: 2 }])); const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try { const query = client.from('notes').select()[mode](); expect(new URLSearchParams(query.toString()).get('limit')).toBe('2'); const result = await query; expect(result.status).toBe(406); expect(result.error?.status).toBe(406); } finally { client.dispose(); }
});
it.each(['limit', 'offset', 'order', 'select', 'or', 'and', 'columns', 'on_conflict'])('preserves reserved column %s (#139)', async column => {
  const mock = mockFetch(json([])); const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try { await client.from('notes').select().eq(column, 5).limit(10); const params = mock.calls[0]!.url.searchParams; expect(params.getAll('and')).toContain(`(${column}.eq."5")`); expect(params.get('limit')).toBe('10'); } finally { client.dispose(); }
});
it('encodes embedded reserved filters in a logic group (#139)', async () => {
  const mock = mockFetch(json([])); const client = createClient('https://api.example.com', { fetch: mock.fetch, auth: { autoRefresh: false } });
  try { await client.from('notes').select('id,items(limit)').eq('items.limit', 5); expect(mock.calls[0]!.url.searchParams.get('items.and')).toBe('(limit.eq."5")'); } finally { client.dispose(); }
});
