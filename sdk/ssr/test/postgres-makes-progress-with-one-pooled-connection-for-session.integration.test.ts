import { expect, it } from "vitest";

import { PostgresSessionStore } from "../src/postgres.js";
import { requiredValue } from "../src/required-value.js";
import { PostgresDatabase } from "./postgres-database.js";
import { fairOwnership, cancelledOwner } from "./postgres-ownership-fixtures.js";

it("makes progress with one pooled connection for session and lineage ownership", async () => {
  const database = new PostgresDatabase({ sizes: [1], timeoutInMs: 500, adminTimeoutInMs: 1000 });
  const pool = requiredValue(database.pools[0], "database pool");
  try {
    await database.create();
    await pool.query("SET statement_timeout='4321ms'");
    const store = new PostgresSessionStore(pool);
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const key = index.toString(16).padStart(64, "0"),
          lineage = "f".repeat(64);
        await store.exclusive(key, async (lease) => {
          expect(
            await requiredValue(
              lease.read?.bind(lease),
              "postgres.integration.test.ts: lease.read",
            ).call(lease, lineage),
          ).toBeNull();
          await requiredValue(
            lease.exclusive?.bind(lease),
            "postgres.integration.test.ts: lease.exclusive",
          ).call(lease, lineage, async (owner) => {
            await owner.save({ sealed: "fixture", expiresAt: Date.now() + 60000 });
            await owner.remove();
          });
          await lease.save({ sealed: "fixture", expiresAt: Date.now() + 60000 });
        });
      }),
    );
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
    expect(
      requiredValue(
        (await pool.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0],
        "database setting",
      ).statement_timeout,
    ).toBe("4321ms");
    const locks = await pool.query<{ count: string }>(
      "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()",
    );
    expect(requiredValue(locks.rows[0], "database result").count).toBe("0");
  } finally {
    await database.dispose();
  }
}, 20000);

it("queues competing app instances fairly and cancels blocked locks on the server", async () => {
  const delayInMs = 10;

  const database = new PostgresDatabase({ sizes: [1, 1], timeoutInMs: 1000 });
  const { admin, name, pools } = database;
  try {
    await database.create(false);
    const one = new PostgresSessionStore(requiredValue(pools[0], "database pool")),
      two = new PostgresSessionStore(requiredValue(pools[1], "database pool"));
    const key = "e".repeat(64);
    const ownership = { one, two, admin, name, pools, key, delayInMs };
    await fairOwnership(ownership);
    expect(
      requiredValue(
        (
          await requiredValue(pools[1], "database pool").query<{ statement_timeout: string }>(
            "SHOW statement_timeout",
          )
        ).rows[0],
        "database setting",
      ).statement_timeout,
    ).toBe("0");

    await cancelledOwner(ownership);
  } finally {
    await database.dispose();
  }
}, 20000);
