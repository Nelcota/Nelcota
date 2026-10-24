import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createClient } from '../../src/index.js';
import { json, mockFetch } from './helpers.js';

const fixture = JSON.parse(readFileSync(new URL('../../../rust/tests/fixtures/protocol.json', import.meta.url), 'utf8')) as {
  rows: Record<string, unknown>[][];
  numeric_rows: string;
  exact_id: string;
  exact_decimal: string;
  http_error: { status: number; body: { code: string; message: string }; retry_after: string };
};

it('preserves shared row, precision and rate-limit wire fixtures', async () => {
  const failure = fixture.http_error;
  const mock = mockFetch(...fixture.rows.map(rows => json(rows)),
    new Response(fixture.numeric_rows), json(failure.body, failure.status, { 'retry-after': failure.retry_after }));
  const client = createClient('https://api.example.com', { fetch: mock.fetch, retries: 0, auth: { autoRefresh: false } });
  try {
    for (const rows of fixture.rows) expect((await client.from('notes').select()).data).toEqual(rows);
    expect((await client.from('notes').select()).data).toEqual([{ id: fixture.exact_id, decimal: fixture.exact_decimal }]);
    const { error } = await client.from('notes').select();
    expect(error).toMatchObject({ status: failure.status, ...failure.body, retryAfter: Number(failure.retry_after) });
  } finally { client.dispose(); }
});
