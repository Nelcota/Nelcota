import { expect, it } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { PostgresSessionStore } from "../src/postgres.js";
import { requiredValue } from "../src/required-value.js";
import { key, value, queryRows, fixture } from "./postgres-fixtures.js";

it("replaces the rotated-away row with a retained tombstone instead of deleting it", async () => {
  const { pool, query, release } = fixture();
  const fresh = "c".repeat(64),
    tombstone = value();
  await new PostgresSessionStore(pool).exclusive(key, async (lease) => {
    await lease.rotate(fresh, tombstone);
  });
  const writes = query.mock.calls.filter(([sql]) => sql.startsWith("SELECT") === false);
  expect(writes).toEqual([
    [expect.stringMatching(/^INSERT/), [key, tombstone.sealed, tombstone.expiresAt]],
  ]);
  await expect(
    new PostgresSessionStore(pool).exclusive(key, (lease) =>
      lease.rotate(fresh, { sealed: "x", expiresAt: 1 }),
    ),
  ).rejects.toMatchObject({ code: "invalid_session" });
  expect(release.mock.calls.every(([destroy]) => destroy === false)).toBe(true);
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
