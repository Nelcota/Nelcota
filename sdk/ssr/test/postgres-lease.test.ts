import { expect, it } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { PostgresSessionStore } from "../src/postgres.js";
import { FakePostgres } from "./fake-postgres.js";
import { key, value, queryRows, fixture } from "./postgres-fixtures.js";
import { requiredValue } from "./required-value.js";

it("replaces the rotated-away row with a retained tombstone instead of deleting it", async () => {
  const database = new FakePostgres(),
    pool = database.pool();
  const fresh = "c".repeat(64),
    tombstone = value();
  database.rows.set(key, { sealed: "credential", expires_at: String(Date.now() + 60000) });
  await new PostgresSessionStore(pool).exclusive(key, async (lease) => {
    await lease.rotate(fresh, tombstone);
  });
  expect(database.rows.get(key)).toEqual({
    sealed: tombstone.sealed,
    expires_at: String(tombstone.expiresAt),
  });
  // Nothing was saved under the fresh key, so nothing is published there.
  expect(database.rows.has(fresh)).toBe(false);
  await expect(
    new PostgresSessionStore(pool).exclusive(key, (lease) =>
      lease.rotate(fresh, { sealed: "x", expiresAt: 1 }),
    ),
  ).rejects.toMatchObject({ code: "invalid_session" });
  expect(pool.borrowed.size).toBe(0);
  expect(database.leakedLocks).toEqual([]);
});

it("reads lineage and takes nested locks without borrowing another connection", async () => {
  const { pool, query, release } = fixture();
  const store = new PostgresSessionStore(pool);
  let late: (() => Promise<unknown>) | undefined;
  await store.exclusive(key, async (lease) => {
    await requiredValue(lease.read?.bind(lease), "postgres.test.ts: lease.read").call(
      lease,
      "b".repeat(64),
    );
    await requiredValue(lease.exclusive?.bind(lease), "postgres.test.ts: lease.exclusive").call(
      lease,
      "b".repeat(64),
      async (owner) => {
        await owner.save(value());
        late = () => owner.remove();
        expect(pool.connect).toHaveBeenCalledTimes(1);
        expect(release).not.toHaveBeenCalled();
      },
    );
    await expect(late?.()).rejects.toMatchObject({ code: "closed_context" });
    await lease.save(value());
  });
  expect(pool.connect).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledExactlyOnceWith(false);
  expect(query.mock.calls.filter(([sql]) => sql.includes("pg_advisory_unlock"))).toHaveLength(2);
});

it("destroys the parent connection after nested persistence fails", async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation((sql) => {
    return promiseResult(() => {
      if (sql.startsWith("INSERT")) throw new Error("nested persistence failed");
      return {
        rows: queryRows(sql),
      };
    });
  });
  await expect(
    new PostgresSessionStore(pool).exclusive(key, async (lease) => {
      await expect(
        requiredValue(lease.exclusive?.bind(lease), "postgres.test.ts: lease.exclusive").call(
          lease,
          "b".repeat(64),
          (owner) => owner.save(value()),
        ),
      ).rejects.toBeDefined();
      expect(lease.signal.aborted).toBe(true);
      await expect(lease.load()).rejects.toMatchObject({ code: "closed_context" });
    }),
  ).rejects.toMatchObject({ code: "session_store" });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it("ends a nested lease when its parent times out and refuses late writes", async () => {
  const { pool, release } = fixture();
  let late: (() => Promise<unknown>) | undefined;
  await expect(
    new PostgresSessionStore(pool, 100, 200).exclusive(key, (lease) =>
      requiredValue(lease.exclusive?.bind(lease), "postgres.test.ts: lease.exclusive").call(
        lease,
        "b".repeat(64),
        async (owner) => {
          const delayInMs = 250;

          late = () => owner.remove();
          await new Promise((resolve) => setTimeout(resolve, delayInMs));
          await owner.remove();
        },
      ),
    ),
  ).rejects.toMatchObject({ code: "session_store" });
  await expect(late?.()).rejects.toMatchObject({ code: "closed_context" });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it("locks the same advisory key as 0.1.x so mixed versions exclude each other", async () => {
  const { pool, query } = fixture();
  await new PostgresSessionStore(pool).exclusive(key, () => promiseResult(() => undefined));
  const locks = query.mock.calls.filter(([sql]) => sql.includes("advisory"));
  expect(locks.map(([sql, values]) => [sql.replace(/ AS \w+$/, ""), values?.[0]])).toEqual([
    ["SELECT pg_advisory_lock(hashtextextended($1, 0))", key],
    ["SELECT pg_advisory_unlock(hashtextextended($1, 0))", key],
  ]);
});

it("retires the rotated-away row after the lease budget instead of failing the write", async () => {
  const { pool, query, release } = fixture();
  const retireDelayInMs = 80,
    workDelayInMs = 150;
  query.mockImplementation(async (sql) => {
    if (sql.startsWith("DELETE"))
      await new Promise((resolve) => setTimeout(resolve, retireDelayInMs));
    return { rows: queryRows(sql) };
  });
  const reported: Error[] = [];
  // The callback ends within the 200ms lease; the retire step ends after it.
  await expect(
    new PostgresSessionStore(pool, { timeout: 100, leaseTimeout: 200 }).exclusive(
      key,
      async (lease) => {
        await lease.rotate("c".repeat(64));
        await new Promise((resolve) => setTimeout(resolve, workDelayInMs));
        await lease.save(value());
        return "published";
      },
      { onRetireError: (error) => reported.push(error) },
    ),
  ).resolves.toBe("published");
  expect(reported).toEqual([]);
  expect(query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(true);
  expect(release).toHaveBeenCalledExactlyOnceWith(false);
});

it("reports a retire step that exceeds its own budget without failing the write", async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation(async (sql) => {
    if (sql.startsWith("DELETE")) return await new Promise<never>(() => undefined);
    return { rows: queryRows(sql) };
  });
  const reported: Error[] = [];
  await expect(
    new PostgresSessionStore(pool, { timeout: 100, leaseTimeout: 1000 }).exclusive(
      key,
      async (lease) => {
        await lease.rotate("c".repeat(64));
        await lease.save(value());
        return "published";
      },
      { onRetireError: (error) => reported.push(error) },
    ),
  ).resolves.toBe("published");
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({ code: "session_store" });
  // The hung statement may still hold the connection: it is destroyed, not pooled.
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  expect(query.mock.calls.filter(([sql]) => sql.includes("pg_advisory_unlock"))).toEqual([]);
});
