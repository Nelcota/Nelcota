import { expect, it, vi } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { PostgresSessionStore, type SessionConnection } from "../src/postgres.js";
import { FakePostgres } from "./fake-postgres.js";
import { key, value, lockOnly, fixture } from "./postgres-fixtures.js";
import { requiredValue } from "./required-value.js";

it("commits each save before returning, then unlocks and returns a clean connection", async () => {
  const database = new FakePostgres(),
    pool = database.pool();
  const store = new PostgresSessionStore(pool),
    other = new PostgresSessionStore(database.pool());
  let late: (() => Promise<unknown>) | undefined;
  await store.exclusive(key, async (lease) => {
    const saved = value();
    await lease.save(saved);
    // Durable before the promise resolves: another process reads it immediately.
    expect(await other.read(key)).toEqual(saved);
    late = () => lease.remove();
    expect(lease.signal.aborted).toBe(false);
  });
  await expect(late?.()).rejects.toMatchObject({ code: "closed_context" });
  expect(pool.idle).toHaveLength(1);
  expect(database.heldBy(requiredValue(pool.idle[0], "idle backend"))).toEqual([]);
  expect(database.leakedLocks).toEqual([]);
  await expect(other.exclusive(key, () => promiseResult(() => "next"))).resolves.toBe("next");
});

it("surfaces unlock ownership loss and destroys the connection", async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation(lockOnly);
  await expect(
    new PostgresSessionStore(pool).exclusive(key, () => promiseResult(() => "accepted")),
  ).rejects.toMatchObject({ code: "session_store", message: "Session lock release failed" });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it("preserves the original callback failure while destroying a failed unlock", async () => {
  const { pool, query, release } = fixture();
  const original = new Error("redirect sentinel");
  query.mockImplementation(lockOnly);
  await expect(
    new PostgresSessionStore(pool).exclusive(key, () => {
      return promiseResult(() => {
        throw original;
      });
    }),
  ).rejects.toBe(original);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it("poisons failed persistence even if the caller catches the error", async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation(async (sql) => {
    if (sql.startsWith("INSERT")) throw new Error("connection lost");
    return await lockOnly(sql);
  });
  await expect(
    new PostgresSessionStore(pool).exclusive(key, async (lease) => {
      await expect(lease.save(value())).rejects.toMatchObject({ code: "session_store" });
      expect(lease.signal.aborted).toBe(true);
      await expect(lease.remove()).rejects.toMatchObject({ code: "closed_context" });
    }),
  ).rejects.toMatchObject({ code: "session_store" });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it("destroys a late connection after its deadline", async () => {
  const { query, release, on, removeListener } = fixture();
  let finish: ((client: SessionConnection) => void) | undefined;
  const store = new PostgresSessionStore(
    {
      connect: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
    100,
  );
  await expect(store.read(key)).rejects.toMatchObject({ code: "session_store" });
  finish?.({ query, release, on, removeListener });
  await Promise.resolve();
  await Promise.resolve();
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it("bounds a stalled owner and prevents late persistence", async () => {
  const { pool, release } = fixture();
  let late: (() => Promise<unknown>) | undefined;
  await expect(
    new PostgresSessionStore(pool, 100, 200).exclusive(key, (lease) => {
      late = () => lease.remove();
      return new Promise(() => undefined);
    }),
  ).rejects.toMatchObject({ code: "session_store" });
  await expect(late?.()).rejects.toMatchObject({ code: "closed_context" });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it("rejects invalid keys before borrowing a connection", async () => {
  const { pool } = fixture();
  await expect(new PostgresSessionStore(pool).read("../bad")).rejects.toMatchObject({
    code: "invalid_session",
  });
  expect(pool.connect).not.toHaveBeenCalled();
});

it("handles asynchronous connection errors without an uncaught event or stale lease", async () => {
  const { pool, release, events } = fixture();
  await expect(
    new PostgresSessionStore(pool).exclusive(key, async (lease) => {
      events.emit("error", new Error("socket closed"));
      expect(lease.signal.aborted).toBe(true);
      await expect(lease.save(value())).rejects.toMatchObject({ code: "closed_context" });
    }),
  ).rejects.toMatchObject({ code: "session_store" });
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
  // The destroyed client's terminal FATAL arrives after release and stays observed.
  expect(() => events.emit("error", new Error("terminating connection"))).not.toThrow();
});

it("queues a busy key locally so its waiter holds no pooled connection", async () => {
  const delayInMs = 20;

  const { pool, release } = fixture();
  const store = new PostgresSessionStore(pool);
  let open: (() => void) | undefined,
    entered = false;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const owner = store.exclusive(key, async () => {
    await gate;
  });
  await vi.waitFor(() => expect(pool.connect).toHaveBeenCalledTimes(1));
  const waiter = store.exclusive(key, () => {
    return promiseResult(() => {
      entered = true;
    });
  });
  await new Promise((resolve) => setTimeout(resolve, delayInMs));
  expect(pool.connect).toHaveBeenCalledTimes(1);
  expect(entered).toBe(false);
  await store.exclusive("b".repeat(64), () => promiseResult(() => undefined));
  expect(pool.connect).toHaveBeenCalledTimes(2);
  open?.();
  await owner;
  await waiter;
  expect(entered).toBe(true);
  expect(pool.connect).toHaveBeenCalledTimes(3);
  expect(release.mock.calls).toEqual([[false], [false], [false]]);
});

it("times out a local waiter without borrowing and keeps later callers ordered", async () => {
  const { pool } = fixture();
  const store = new PostgresSessionStore(pool, 100, 200);
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const owner = store.exclusive(key, async () => {
    await gate;
  });
  await expect(store.exclusive(key, () => promiseResult(() => "late"))).rejects.toMatchObject({
    code: "session_store",
    message: "Session lock acquisition timed out",
  });
  expect(pool.connect).toHaveBeenCalledTimes(1);
  const next = store.exclusive(key, () => promiseResult(() => "next"));
  open?.();
  await owner;
  await expect(next).resolves.toBe("next");
});

it("bounds a queued backend lock with a server deadline and destroys a connection after other failures", async () => {
  const { pool, query, release } = fixture();
  query.mockImplementation((sql) => {
    return promiseResult(() => {
      if (sql.includes("current_setting")) return { rows: [{ timeout: "3s" }] };
      if (sql.includes("pg_advisory_lock(")) throw new Error("server closed the connection");
      return { rows: [] };
    });
  });
  await expect(
    new PostgresSessionStore(pool, { timeout: 100, leaseTimeout: 200, lockTimeout: 100 }).exclusive(
      key,
      () => promiseResult(() => "never"),
    ),
  ).rejects.toMatchObject({ code: "session_store" });
  const setting = query.mock.calls.find(([sql]) => sql.includes("set_config"));
  expect(setting?.[1]?.[0]).toMatch(/^\d+ms$/);
  expect(Number(String(setting?.[1]?.[0]).replace("ms", ""))).toBeLessThan(100);
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it("never returns a connection that may hold a lock, even when a grant races the cancel", async () => {
  const { pool, query, release } = fixture();
  const calls: string[] = [];
  query.mockImplementation((sql) => {
    return promiseResult(() => {
      calls.push(sql);
      if (sql.includes("current_setting")) return { rows: [{ timeout: "3s" }] };
      if (sql.includes("pg_advisory_lock("))
        throw Object.assign(new Error("canceling statement due to statement timeout"), {
          code: "57014",
        });
      return { rows: [] };
    });
  });
  await expect(
    new PostgresSessionStore(pool, 100, 200).exclusive(key, () => promiseResult(() => "never")),
  ).rejects.toMatchObject({ code: "session_store", message: "Session lock acquisition timed out" });
  const cancelled = calls.findIndex((sql) => sql.includes("pg_advisory_lock("));
  expect(calls.slice(cancelled + 1)).toEqual([
    expect.stringContaining("set_config"),
    "SELECT pg_advisory_unlock_all()",
  ]);
  expect(release).toHaveBeenCalledExactlyOnceWith(false);
});

it("rotates to a fresh key on the same connection and releases both locks", async () => {
  const database = new FakePostgres(),
    pool = database.pool();
  const fresh = "c".repeat(64);
  database.rows.set(key, { sealed: "old", expires_at: String(Date.now() + 60000) });
  const saved = value();
  await new PostgresSessionStore(pool).exclusive(key, async (lease) => {
    await lease.rotate(fresh);
    await lease.save(saved);
    expect(pool.borrowed.size).toBe(1);
  });
  expect(database.rows.has(key)).toBe(false);
  expect(database.rows.get(fresh)?.sealed).toBe(saved.sealed);
  expect(pool.idle).toHaveLength(1);
  expect(database.heldBy(requiredValue(pool.idle[0], "idle backend"))).toEqual([]);
  expect(database.leakedLocks).toEqual([]);
});

it("requires a lease that leaves auth time after reserving the final save", async () => {
  const { pool } = fixture();
  expect(() => new PostgresSessionStore(pool, 5000, 9999)).toThrow(
    expect.objectContaining({ code: "configuration" }),
  );
  const store = new PostgresSessionStore(pool, 5000, 10000),
    started = Date.now();
  await store.exclusive(key, (lease) => {
    return promiseResult(() => {
      expect(lease.deadline).toBeGreaterThanOrEqual(started + 5000);
      expect(lease.deadline).toBeLessThanOrEqual(Date.now() + 5000);
    });
  });
});
