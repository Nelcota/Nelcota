import { randomBytes } from "node:crypto";

import { expect, it } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { PostgresSessionStore } from "../src/postgres.js";
import { requiredValue } from "../src/required-value.js";
import { gate as controlGate } from "./gate.js";
import { PostgresDatabase } from "./postgres-database.js";
import {
  verifyConnectionLoss,
  createAppInstances,
  verifyCredentialCount,
  Exchange,
  bootstrapBrowser,
  publishedIdentities,
} from "./postgres-integration-fixtures.js";

it("serializes two independent store instances and survives connection loss on a disposable database", async () => {
  const database = new PostgresDatabase({ sizes: [2, 2], timeoutInMs: 2000 });
  const first = requiredValue(database.pools[0], "database pool"),
    second = requiredValue(database.pools[1], "database pool");
  try {
    await database.create();
    const a = new PostgresSessionStore(first, 2000),
      b = new PostgresSessionStore(second, 2000);
    const key = "a".repeat(64),
      value = { sealed: "opaque-one", expiresAt: Date.now() + 60000 };
    const { promise: ready, open: acquired } = controlGate();
    const { promise: gate, open: release } = controlGate();
    const owner = a.exclusive(key, async (lease) => {
      await lease.save(value);
      acquired();
      await gate;
    });
    await ready;
    // Independent connection reads a durable save while the owner still holds its lock.
    expect(await b.read(key)).toEqual(value);
    let entered = false;
    const follower = b.exclusive(key, async (lease) => {
      entered = true;
      expect(await lease.load()).toEqual(value);
      await lease.remove();
    });
    const independent = await b.exclusive("b".repeat(64), () => promiseResult(() => true));
    expect(independent).toBe(true);
    expect(entered).toBe(false);
    release();
    await owner;
    await follower;
    expect(await a.read(key)).toBeNull();
    await verifyConnectionLoss(a, b, { first, second, key, value });
  } finally {
    await database.dispose();
  }
}, 20000);

it("orders concurrent first sign-ins from two app instances and leaves one credential row", async () => {
  const database = new PostgresDatabase({ sizes: [4, 4], timeoutInMs: 2000 });
  const { pools } = database;
  try {
    await database.create();
    const secret = randomBytes(32).toString("base64url");

    const [one, two] = await createAppInstances(pools, secret);
    const browser = bootstrapBrowser(requiredValue(one, "required operation value"));
    const post = () =>
      new Request("http://localhost:3000/login", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      });
    const tabA = new Exchange(new Map(browser)),
      tabB = new Exchange(new Map(browser));
    await Promise.all([
      requiredValue(one, "required operation value").write(tabA, post(), (context) =>
        context.auth.signInWithPassword({
          email: "alice@example.test",
          password: "fixture-password",
        }),
      ),
      requiredValue(two, "required operation value").write(tabB, post(), (context) =>
        context.auth.signInWithPassword({
          email: "bob@example.test",
          password: "fixture-password",
        }),
      ),
    ]);
    expect(tabA.sets).toHaveLength(1);
    expect(tabB.sets).toHaveLength(1);
    // Which instance won the bootstrap lock is not fixed; the later publication is the head.
    const results = await publishedIdentities(requiredValue(two, "required operation value"), [
      tabA,
      tabB,
    ]);
    expect(results.filter((result) => result.superseded)).toHaveLength(1);
    expect(results.filter((result) => result.user !== null)).toHaveLength(1);
    // Whichever response the browser keeps, the superseded identity cannot authenticate.
    await verifyCredentialCount(requiredValue(pools[0], "database pool"), secret);
  } finally {
    await database.dispose();
  }
}, 20000);
