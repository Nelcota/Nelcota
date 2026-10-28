/** Test-only PostgreSQL fixtures. Import from `@nelcota/client/testing`. */
export interface TestSql {
  query<Row = Record<string, unknown>>(text: string, parameters?: readonly unknown[]): Promise<Row[]>;
}

export interface PgTestConnection {
  query(text: string, parameters?: unknown[]): PromiseLike<{ rows: Record<string, unknown>[] }>;
  release(error?: Error | boolean): void;
}
export interface PgTestPool { connect(): PromiseLike<PgTestConnection> }
export interface BunTestConnection {
  unsafe(text: string, parameters?: unknown[]): PromiseLike<Record<string, unknown>[]>;
  release(): void;
}
export interface BunTestPool { reserve(): PromiseLike<BunTestConnection> }
export interface RollbackTransaction {
  sql: TestSql;
  /** Roll back and release the reserved connection. Repeated calls are harmless. */
  rollback(): Promise<void>;
}

/** Reserve a dedicated pg/Bun connection and begin a transaction that callers roll back in `finally`. */
export async function openRollbackTransaction(pool: PgTestPool | BunTestPool): Promise<RollbackTransaction> {
  const connection = 'reserve' in pool ? await pool.reserve() : await pool.connect();
  const release = (destroy = false): void => {
    if ('unsafe' in connection) { connection.release(); return; }
    connection.release(destroy);
  };
  let closed = false;
  const sql: TestSql = {
    async query<Row>(text: string, parameters: readonly unknown[] = []): Promise<Row[]> {
      if (closed) throw new Error('The rollback transaction has been closed');
      if ('unsafe' in connection) return [...await connection.unsafe(text, [...parameters])] as Row[];
      return (await connection.query(text, [...parameters])).rows as Row[];
    },
  };
  try { await sql.query('BEGIN'); }
  catch (error) { release(true); throw error; }
  return {
    sql,
    async rollback(): Promise<void> {
      if (closed) return;
      try { await sql.query('ROLLBACK'); }
      catch (error) { release(true); closed = true; throw error; }
      closed = true;
      connection.release();
    },
  };
}

/** Run one scenario and always roll back its fixtures, including after assertion failures. */
export async function withRollbackTransaction<T>(pool: PgTestPool | BunTestPool, scenario: (sql: TestSql) => Promise<T>): Promise<T> {
  const transaction = await openRollbackTransaction(pool);
  try { return await scenario(transaction.sql); }
  finally { await transaction.rollback(); }
}

/** Impersonate an API role using transaction-local role and JWT claims. Create fixtures before switching roles. */
export async function actAs(sql: TestSql, role: 'anon' | 'authenticated' | 'service_role', userId?: string): Promise<void> {
  if (!['anon', 'authenticated', 'service_role'].includes(role)) throw new TypeError('Unknown API role');
  if (role === 'authenticated' && !userId) throw new TypeError('An authenticated scenario needs a user ID');
  if (userId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) throw new TypeError('User ID must be a UUID');
  const claims = JSON.stringify({ role, ...(role !== 'anon' && userId ? { sub: userId } : {}) });
  await sql.query("SELECT set_config('role', $1, true), set_config('request.jwt.claims', $2, true)", [role, claims]);
}

/** Switch to anonymous access and clear the previous user's identity claims. */
export async function actAsAnonymous(sql: TestSql): Promise<void> { await actAs(sql, 'anon'); }

/** Insert a confirmed, passwordless test identity using the fixture owner's connection. */
export async function createAuthUser(sql: TestSql, options: { id?: string; email?: string } = {}): Promise<{ id: string; email: string }> {
  const id = options.id ?? globalThis.crypto.randomUUID();
  const email = (options.email ?? `rls-${id}@example.test`).toLowerCase();
  const [user] = await sql.query<{ id: string; email: string }>(
    'INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now()) RETURNING id::text, email', [id, email],
  );
  if (!user) throw new Error('The test identity was not returned');
  return user;
}

let nextSavepoint = 0;
/** Expect a PostgreSQL SQLSTATE while recovering the scenario transaction with a savepoint. */
export async function expectSqlState(sql: TestSql, expected: string, operation: () => PromiseLike<unknown>): Promise<void> {
  if (!/^[A-Z0-9]{5}$/.test(expected)) throw new TypeError('Expected a five-character SQLSTATE');
  const savepoint = `nelcota_test_${++nextSavepoint}`;
  await sql.query(`SAVEPOINT ${savepoint}`);
  let failure: unknown;
  let rejected = false;
  try { await operation(); }
  catch (error) { rejected = true; failure = error; }
  finally {
    await sql.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await sql.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  const record = failure as { code?: unknown; errno?: unknown } | null;
  const actual = record?.errno ?? record?.code;
  if (!rejected || actual !== expected) throw new Error(`Expected SQLSTATE ${expected}; received ${rejected ? String(actual) : 'a successful query'}`, { cause: failure });
}
