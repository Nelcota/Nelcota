import { expect, it } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { PostgresSessionStore } from "../src/postgres.js";
import { FakePostgres } from "./fake-postgres.js";
import { gate as controlGate } from "./gate.js";
import { key, fixture } from "./postgres-fixtures.js";
import { requiredValue } from "./required-value.js";

// Lock-wait budgets, server-side cancellation and the write-lease limit, against a
// fake that reuses pooled backends (settings and locks included) like node-postgres.
it("cancels a lock wait on the server and returns the connection, settings restored, to the pool", async () => {
  const database = new FakePostgres(),
    pool = database.pool(1);
  const holder = new PostgresSessionStore(database.pool()),
    waiter = new PostgresSessionStore(pool, { timeout: 100, leaseTimeout: 400, lockTimeout: 100 });
  const { promise, open } = controlGate();
  const { promise: entered, open: enter } = controlGate();
  const held = holder.exclusive(key, async () => {
    enter();
    await promise;
  });
  await entered;
  await expect(waiter.exclusive(key, () => promiseResult(() => "late"))).rejects.toMatchObject({
    code: "session_store",
    message: "Session lock acquisition timed out",
  });
  const backend = requiredValue(pool.idle[0], "idle backend");
  expect(database.statementTimeout(backend)).toBe("0");
  expect(database.heldBy(backend)).toEqual([]);
  open();
  await held;
  // The next borrower reuses the same backend and must really own the key.
  await waiter.exclusive(key, () => {
    return promiseResult(() => {
      expect(pool.borrowed.has(backend)).toBe(true);
    });
  });
  expect(database.leakedLocks).toEqual([]);
});

it("lets a waiter outlast an owner that stays within its lease", async () => {
  const delayInMs = 250;
  const database = new FakePostgres();
  const options = { timeout: 100, leaseTimeout: 1000 };
  const one = new PostgresSessionStore(database.pool(), options),
    two = new PostgresSessionStore(database.pool(), options);
  const { promise: entered, open: enter } = controlGate();
  const owner = one.exclusive(key, async () => {
    enter();
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
  });
  await entered;
  await expect(two.exclusive(key, () => promiseResult(() => "after"))).resolves.toBe("after");
  await owner;
});

it("keeps pooled connections for reads while write leases are busy", async () => {
  const database = new FakePostgres(),
    pool = database.pool(2);
  const store = new PostgresSessionStore(pool, { timeout: 100, leaseTimeout: 400 });
  const { promise, open } = controlGate();
  const { promise: entered, open: enter } = controlGate();
  const slow = store.exclusive(key, async () => {
    enter();
    await promise;
  });
  await entered;
  let second = false;
  const queued = store.exclusive("b".repeat(64), () => {
    return promiseResult(() => {
      second = true;
    });
  });
  // Half of a two-connection pool is one lease: the read still finds a connection.
  await expect(store.read("d".repeat(64))).resolves.toBeNull();
  expect(second).toBe(false);
  open();
  await slow;
  await queued;
  expect(second).toBe(true);
});

it("fails a writer that cannot get a lease slot within its lock timeout", async () => {
  const database = new FakePostgres();
  const store = new PostgresSessionStore(database.pool(), {
    timeout: 100,
    leaseTimeout: 400,
    lockTimeout: 100,
    maxLeases: 1,
  });
  const { promise, open } = controlGate();
  const { promise: entered, open: enter } = controlGate();
  const slow = store.exclusive(key, async () => {
    enter();
    await promise;
  });
  await entered;
  await expect(
    store.exclusive("b".repeat(64), () => promiseResult(() => "late")),
  ).rejects.toMatchObject({ code: "session_capacity" });
  open();
  await slow;
  await expect(store.exclusive("b".repeat(64), () => promiseResult(() => "now"))).resolves.toBe(
    "now",
  );
});

it("validates lease, lock and capacity settings", () => {
  const { pool } = fixture();
  for (const options of [
    { timeout: 100, leaseTimeout: 400, lockTimeout: 50 },
    { timeout: 100, leaseTimeout: 400, lockTimeout: 401 },
    { maxLeases: 0 },
    { maxLeases: 1.5 },
  ])
    expect(() => new PostgresSessionStore(pool, options)).toThrow(
      expect.objectContaining({ code: "configuration" }),
    );
});
