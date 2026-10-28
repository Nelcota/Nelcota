// Real PostgreSQL policy scenarios through both pg and Bun.SQL (when on Bun).
import assert from 'node:assert/strict';
import pg from 'pg';
import { actAs, actAsAnonymous, createAuthUser, expectSqlState, openRollbackTransaction, withRollbackTransaction } from '../../dist/testing.js';

const url = process.env.NELCOTA_TESTING_DATABASE_URL;
if (!url) throw new Error('Set NELCOTA_TESTING_DATABASE_URL to an owned disposable Nelcota database');
const pools = [new pg.Pool({ connectionString: url, max: 2 })];
if (globalThis.Bun) pools.push(new Bun.SQL(url, { max: 2 }));
try {
  for (const pool of pools) {
    let userId;
    await withRollbackTransaction(pool, async sql => {
      const user = await createAuthUser(sql);
      userId = user.id;
      await sql.query('CREATE TABLE public.testing_notes (owner uuid NOT NULL DEFAULT auth.uid(), title text NOT NULL)');
      await sql.query('ALTER TABLE public.testing_notes ENABLE ROW LEVEL SECURITY');
      await sql.query('GRANT SELECT, INSERT ON public.testing_notes TO authenticated, anon');
      await sql.query('CREATE POLICY own_notes ON public.testing_notes TO authenticated USING (owner = auth.uid()) WITH CHECK (owner = auth.uid())');
      await actAs(sql, 'authenticated', user.id);
      assert.deepEqual(await sql.query('SELECT auth.uid()::text AS id'), [{ id: user.id }]);
      await sql.query('INSERT INTO public.testing_notes (title) VALUES ($1)', ['owned']);
      await expectSqlState(sql, '42501', () => sql.query('INSERT INTO public.testing_notes (owner, title) VALUES ($1, $2)', [crypto.randomUUID(), 'foreign']));
      assert.equal((await sql.query('SELECT * FROM public.testing_notes')).length, 1);
      await actAsAnonymous(sql);
      assert.equal((await sql.query('SELECT auth.uid()::text AS id'))[0].id, null);
      assert.equal((await sql.query('SELECT * FROM public.testing_notes')).length, 0);
    });
    const transaction = await openRollbackTransaction(pool);
    try {
      assert.equal((await transaction.sql.query('SELECT id FROM auth.users WHERE id = $1', [userId])).length, 0);
      assert.equal((await transaction.sql.query("SELECT to_regclass('public.testing_notes') AS name"))[0].name, null);
      assert.equal((await transaction.sql.query('SELECT current_user AS name'))[0].name, 'postgres');
      await assert.rejects(withRollbackTransaction(pool, async sql => {
        await createAuthUser(sql, { id: userId });
        throw new Error('assertion fixture');
      }), /assertion fixture/);
      assert.equal((await transaction.sql.query('SELECT id FROM auth.users WHERE id = $1', [userId])).length, 0);
    } finally { await transaction.rollback(); await transaction.rollback(); }
    console.log(`PASS: ${'reserve' in pool ? 'Bun.SQL' : 'pg'} claims, policy rejection, savepoint recovery, anonymous access and rollback cleanup`);
  }
} finally {
  for (const pool of pools) {
    if ('end' in pool) await pool.end();
    if ('close' in pool) await pool.close();
  }
}
