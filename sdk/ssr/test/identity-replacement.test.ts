import { expect, it, vi } from "vitest";

import type { SessionError } from "../src/errors.js";
import { promiseResult } from "../src/lifecycle/promise-result.js";
import { PostgresSessionStore } from "../src/postgres.js";
import { user, session, Jar, post, setup, credentials } from "./context-fixtures.js";
import { FakePostgres } from "./fake-postgres.js";
import { requiredValue } from "./required-value.js";

/** Each token request issues a distinct upstream session; logout may be made to fail. */
function upstream(options: { logoutStatus?: number } = {}) {
  let issued = 0;
  const logouts: string[] = [];
  const fetch = vi.fn((url: string | URL | Request, init: RequestInit = {}) => {
    return promiseResult(() => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path === "/auth/v1/token") {
        issued++;
        return Response.json(session(`access-${issued}`, `refresh-${issued}`));
      }
      if (path === "/auth/v1/logout") {
        logouts.push(new Headers(init.headers).get("authorization") ?? "");
        return new Response(null, { status: options.logoutStatus ?? 204 });
      }
      return Response.json(path === "/auth/v1/user" ? user : []);
    });
  });
  return { fetch, logouts };
}

it("revokes the upstream session a new sign-in replaced, after publishing the new one", async () => {
  const { fetch, logouts } = upstream();
  const { integration, jar } = await setup({ fetch });
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  expect(logouts).toEqual([]);
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  expect(logouts).toEqual(["Bearer access-1"]);
  await integration.read(jar, async ({ hasSession }) => {
    await Promise.resolve();
    expect(hasSession).toBe(true);
  });
});

/** An unsigned access token carrying `session_id`; the SDK only reads its payload. */
function accessToken(sessionId: string, issued: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ session_id: sessionId, n: issued })}.signature`;
}

it.each([
  ["keeps", ["upstream-1", "upstream-1"], 0],
  ["revokes", ["upstream-1", "upstream-2"], 1],
] as const)(
  "%s the previous upstream session by its session_id claim, not its stored JSON",
  async (_outcome, sessionIds, revoked) => {
    let issued = 0;
    const tokens: string[] = [];
    const logouts: string[] = [];
    const fetch = vi.fn((url: string | URL | Request, init: RequestInit = {}) => {
      return promiseResult(() => {
        const path = new URL(url instanceof Request ? url.url : url).pathname;
        if (path === "/auth/v1/token") {
          const token = accessToken(requiredValue(sessionIds[issued], "session id"), issued);
          issued++;
          tokens.push(token);
          return Response.json(session(token, `refresh-${issued}`));
        }
        if (path === "/auth/v1/logout") {
          logouts.push(new Headers(init.headers).get("authorization") ?? "");
          return new Response(null, { status: 204 });
        }
        return Response.json(path === "/auth/v1/user" ? user : []);
      });
    });
    const { integration, jar } = await setup({ fetch });
    await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
    // The second answer differs in every token, but may continue the same upstream session.
    await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(logouts).toEqual(revoked === 0 ? [] : [`Bearer ${tokens[0] ?? ""}`]);
    await integration.read(jar, async ({ hasSession }) => {
      await Promise.resolve();
      expect(hasSession).toBe(true);
    });
  },
);

it("keeps a sign-in when revoking the replaced session fails and reports it without tokens", async () => {
  const { fetch, logouts } = upstream({ logoutStatus: 503 });
  const reported: SessionError[] = [];
  const { integration, jar } = await setup({
    fetch,
    onBackgroundError: (error) => reported.push(error),
  });
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const result = await integration.write(jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  expect(result.error).toBeNull();
  expect(logouts).toEqual(["Bearer access-1"]);
  expect(reported.map((error) => error.code)).toEqual(["session_store"]);
  expect(JSON.stringify(reported)).not.toMatch(/access-|refresh-/);
  expect(reported[0]?.cause).toBeUndefined();
});

it("writes the new row, then the lineage head, and replaces the old row last", async () => {
  const { fetch } = upstream();
  const database = new FakePostgres();
  const { integration, jar } = await setup({
    fetch,
    store: new PostgresSessionStore(database.pool()),
  });
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const keys = new Set(database.rows.keys());
  const order: string[] = [];
  const set = database.rows.set.bind(database.rows);
  vi.spyOn(database.rows, "set").mockImplementation((key, row) => {
    order.push(keys.has(key) ? `existing:${key}` : `new:${key}`);
    return set(key, row);
  });
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const created = order.filter((entry) => entry.startsWith("new:"));
  expect(created).toHaveLength(1);
  const [fresh, head, tombstone] = order;
  expect(fresh).toBe(created[0]);
  expect(head?.startsWith("existing:")).toBe(true);
  expect(tombstone?.startsWith("existing:")).toBe(true);
  expect(head).not.toBe(tombstone);
  expect(database.leakedLocks).toEqual([]);
});

it("publishes a sign-in and revokes the replaced session when retiring the old row fails", async () => {
  const { fetch, logouts } = upstream();
  const database = new FakePostgres();
  const reported: SessionError[] = [];
  const { integration, jar } = await setup({
    fetch,
    store: new PostgresSessionStore(database.pool()),
    onBackgroundError: (error) => reported.push(error),
  });
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const published = jar.writes.length;
  const keys = new Set(database.rows.keys());
  let existing = 0;
  const set = database.rows.set.bind(database.rows);
  vi.spyOn(database.rows, "set").mockImplementation((key, row) => {
    // The new row, the lineage head, then the tombstone over the old row.
    if (keys.has(key) && ++existing === 2) throw new Error("tombstone write failed");
    return set(key, row);
  });
  const result = await integration.write(jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  expect(result.error).toBeNull();
  expect(jar.writes.length).toBeGreaterThan(published);
  expect(logouts).toEqual(["Bearer access-1"]);
  expect(reported.map((error) => error.message)).toEqual([
    "A replaced session row could not be retired",
  ]);
  expect(reported[0]?.cause).toBeUndefined();
  expect(database.leakedLocks).toEqual([]);
  await integration.read(jar, async ({ hasSession }) => {
    await Promise.resolve();
    expect(hasSession).toBe(true);
  });
});

it("leaves the previous row and upstream session alone when the write fails", async () => {
  const { fetch, logouts } = upstream();
  const database = new FakePostgres();
  const { integration, jar } = await setup({
    fetch,
    store: new PostgresSessionStore(database.pool()),
  });
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const before = new Map(database.rows);
  const cookie = requiredValue(jar.writes.at(-1), "published cookie");
  const failure = new Error("handler failed after sign-in");
  await expect(
    integration.write(jar, post(), async (context) => {
      await context.auth.signInWithPassword(credentials);
      throw failure;
    }),
  ).rejects.toBe(failure);
  // Only the lineage head moved: the previous credential row was not replaced by a
  // tombstone (the lease failed) and its upstream session was not revoked.
  expect(before.size).toBe(2);
  const changed = [...before].filter(([key, row]) => database.rows.get(key)?.sealed !== row.sealed);
  expect(changed).toHaveLength(1);
  expect(logouts).toEqual([]);
  // The head no longer names the previous row, so its cookie reads as replaced.
  const previous = new Jar();
  previous.values.set(cookie.name, cookie.value);
  await integration.read(previous, async ({ hasSession, superseded }) => {
    await Promise.resolve();
    expect(hasSession).toBe(false);
    expect(superseded).toBe(true);
  });
});

it("accepts the explicit oauthCallback form only for the configured callback GET", async () => {
  const { integration, jar } = await setup();
  await expect(
    integration.oauthCallback(jar, post(), (context) => context.auth.exchangeCode("fixture")),
  ).rejects.toMatchObject({ code: "csrf" });
});
