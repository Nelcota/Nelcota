import type { Pool } from "pg";
import { expect } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { PostgresSessionStore } from "../src/postgres.js";
import { gate as controlGate } from "./gate.js";
import { waitForQueuedOwner } from "./postgres-integration-fixtures.js";
import { requiredValue } from "./required-value.js";
type Ownership = {
  one: PostgresSessionStore;
  two: PostgresSessionStore;
  admin: Pool;
  name: string;
  pools: Pool[];
  key: string;
  delayInMs: number;
};
export async function fairOwnership({
  one,
  two,
  admin,
  name,
  key,
  delayInMs,
}: Ownership): Promise<void> {
  const order: string[] = [];
  const { promise: ready, open: entered } = controlGate();
  const { promise: gate, open: release } = controlGate();
  try {
    const owner = one.exclusive(key, async () => {
      entered();
      await gate;
    });
    await ready;
    const local = one.exclusive(key, () => {
      return promiseResult(() => {
        order.push("local");
      });
    });
    const remote = two.exclusive(key, () => {
      return promiseResult(() => {
        order.push("remote");
      });
    });
    await waitForQueuedOwner(admin, name, delayInMs);
    requiredValue(release, "required operation value")();
    await owner;
    await remote;
    await local;
    expect(order).toEqual(["remote", "local"]);
  } finally {
    release();
  }
}
export async function cancelledOwner({ one, admin, name, pools, key }: Ownership): Promise<void> {
  let unblock!: () => void;
  const { promise: acquiredGate, open: acquired } = controlGate();
  const held = one.exclusive(key, async () => {
    acquired();
    await new Promise<void>((resolve) => {
      unblock = resolve;
    });
  });
  await acquiredGate;
  try {
    await expect(
      new PostgresSessionStore(requiredValue(pools[1], "database pool"), 100, 200).exclusive(
        key,
        () => promiseResult(() => true),
      ),
    ).rejects.toMatchObject({ code: "session_store" });
    const waiting = await admin.query<{ count: string }>(
      "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=$1)",
      [name],
    );
    expect(requiredValue(waiting.rows[0], "database result").count).toBe("0");
  } finally {
    unblock();
    await held;
  }
}
