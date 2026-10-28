# Testing RLS

Keep policy scenarios beside application migrations in `migrations/tests/`.
Run them against a disposable `nelcota dev` database after applying your
migrations. The test process needs the local administrator connection to create
fixtures and impersonate API roles. Never run these helpers against production.

The `@nelcota/client/testing` export has no runtime dependencies and does not
load the browser client. It supports a `pg.Pool` on Node or Bun and `Bun.SQL`.
Use the source build containing this export until its SDK release is published.

## Start a local scenario

```sh
nelcota dev
# In another terminal in the application folder:
nelcota migrate
set -a
. .nelcota/dev.env
set +a
bun test migrations/tests
```

`DATABASE_URL` is the direct, URL-encoded local PostgreSQL connection. A test
runner may run scenarios in parallel only if each reserves its own connection
and uses independent fixtures. Keep statements within one scenario sequential.

```ts
// migrations/tests/notes.test.ts
import { afterAll, expect, test } from 'bun:test';
import { SQL } from 'bun';
import {
  actAs, actAsAnonymous, createAuthUser, expectSqlState,
  withRollbackTransaction,
} from '@nelcota/client/testing';

const database = new SQL(process.env.DATABASE_URL!);
afterAll(() => database.close());

test('a member cannot insert notes for another member', async () => {
  await withRollbackTransaction(database, async sql => {
    // Create identities and seed data before switching to an API role.
    const member = await createAuthUser(sql);
    const other = await createAuthUser(sql);
    await actAs(sql, 'authenticated', member.id);
    await expectSqlState(sql, '42501', () => sql.query(
      'INSERT INTO public.notes (owner, body) VALUES ($1, $2)',
      [other.id, 'forbidden'],
    ));
    // expectSqlState uses a savepoint, so a rejected query does not abort
    // the rest of this scenario. Verify anonymous access separately.
    await actAsAnonymous(sql);
    expect(await sql.query('SELECT * FROM public.notes')).toEqual([]);
  }); // Always rolls back, including if the assertion throws.
});
```

On Node, install `pg`, pass `new Pool({ connectionString: process.env.DATABASE_URL })`
to the same helpers, and close the pool with `pool.end()` after the suite.
No driver is bundled or required by the ordinary SDK entry points.

## Fixture contract

- `openRollbackTransaction(pool)` returns `{ sql, rollback }`; always call
  `rollback()` in `finally`. Prefer `withRollbackTransaction(pool, scenario)`
  to make cleanup automatic. These helpers reserve one dedicated connection.
- `actAs(sql, 'authenticated', userId)` sets transaction-local role and JWT
  claims, using the same `role`/`sub` format as the API. `actAsAnonymous(sql)`
  clears the previous subject. Both changes disappear on rollback.
- `createAuthUser(sql, { id?, email? })` creates a confirmed, passwordless
  fixture identity. It does not sign in or issue tokens; use the administrator
  fixture connection before impersonation.
- `expectSqlState(sql, '42501', operation)` verifies a database rejection and
  restores a savepoint. It accepts pg's `code` and Bun's `errno` SQLSTATE field,
  as described in [Bun's SQL error contract](https://bun.sh/docs/runtime/sql).

Do not issue `COMMIT` or change transaction ownership inside a scenario. Test
RLS-hidden reads and writes as zero-row results as well as testing `WITH CHECK`
failures. Exercise two users, anonymous access and every permitted write verb.
Use HTTP/SDK contract tests separately for JWT verification and route behavior.
