import type { Pool } from "pg";
import { expect } from "vitest";

import { type CookieWriter, Integration } from "../src/context.js";
import { promiseResult } from "../src/lifecycle/promise-result.js";
import { PostgresSessionStore } from "../src/postgres.js";
import { SessionSealer } from "../src/sealing/seal.js";
import { requestUser } from "./request-values.js";
import { requiredValue } from "./required-value.js";

async function countCredentials(
  rows: { key: string; sealed: string }[],
  sealer: SessionSealer,
): Promise<number> {
  let credentials = 0;
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- Keep lock observations and cleanup ordered on the owned database fixture.
    const state = await sealer
      .open(
        row.sealed,
        `nelcota-next/v1\0http://localhost:3000\0http://localhost:8000/\0${row.key}`,
      )
      .catch(() => null);
    if (state?.session != null && state.session !== "") credentials++;
  }
  return credentials;
}

async function waitForQueuedOwner(admin: Pool, name: string, delayInMs: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Keep lock observations and cleanup ordered on the owned database fixture.
    const queued = await admin.query<{ count: string }>(
      "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=$1)",
      [name],
    );
    if (requiredValue(queued.rows[0], "database result").count === "1") break;
    if (attempt > 100) throw new Error("Competing app did not join the server lock queue");
    // oxlint-disable-next-line no-await-in-loop -- Keep lock observations and cleanup ordered on the owned database fixture.
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
  }
}

type CookieOptions = Parameters<CookieWriter["set"]>[2];

class Exchange implements CookieWriter {
  readonly sets: { name: string; value: string; options: CookieOptions }[] = [];
  constructor(readonly presented: Map<string, string>) {}
  get(name: string): { value: string } | undefined {
    const value = this.presented.get(name);
    return value != null && value !== "" ? { value } : undefined;
  }
  set(name: string, value: string, options: CookieOptions): void {
    this.sets.push({ name, value, options });
  }
}
export { countCredentials, waitForQueuedOwner, Exchange };

export const integrationFetch = (
  target: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> => {
  return promiseResult(() => {
    const path = new URL(target instanceof Request ? target.url : target).pathname;
    if (path === "/auth/v1/token") {
      const user = requestUser(init);
      return Response.json({
        access_token: `access-${user}`,
        refresh_token: `refresh-${user}`,
        token_type: "bearer",
        expires_in: 900,
        expires_at: Math.floor(Date.now() / 1000) + 900,
        user: {
          id: user,
          email: `${user}@example.test`,
          email_confirmed_at: null,
          user_metadata: {},
          created_at: "",
          last_sign_in_at: null,
        },
      });
    }
    const token = new Headers(init.headers).get("authorization")?.replace("Bearer access-", "");
    return Response.json({
      id: token,
      email: `${token}@example.test`,
      email_confirmed_at: null,
      user_metadata: {},
      created_at: "",
      last_sign_in_at: null,
    });
  });
};

/** Starts two browser tabs from one newly issued bootstrap identity. */
export function bootstrapBrowser(integration: Integration<unknown>): Map<string, string> {
  const browser = new Map<string, string>(),
    boot = new Exchange(browser);
  integration.bootstrap(boot, boot);
  browser.set(
    requiredValue(boot.sets[0], "published cookie").name,
    requiredValue(boot.sets[0], "published cookie").value,
  );
  return browser;
}
/** Reads every published cookie through an independent application instance. */
export function publishedIdentities(integration: Integration<unknown>, tabs: readonly Exchange[]) {
  return Promise.all(
    tabs.map((tab) =>
      integration.read(
        new Exchange(
          new Map([
            [
              requiredValue(tab.sets[0], "published cookie").name,
              requiredValue(tab.sets[0], "published cookie").value,
            ],
          ]),
        ),
        async (context) => ({
          user: (await context.getUser()).data?.id ?? null,
          superseded: context.superseded,
        }),
      ),
    ),
  );
}

/** Verifies recovery after the server terminates a lock owner's connection. */
export async function verifyConnectionLoss(
  a: PostgresSessionStore,
  b: PostgresSessionStore,
  {
    first,
    second,
    key,
    value,
  }: { first: Pool; second: Pool; key: string; value: { sealed: string; expiresAt: number } },
) {
  await expect(
    a.exclusive(key, async (lease) => {
      const backend = await first.query<{ pid: number }>(
        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND granted",
      );
      expect(backend.rows).toHaveLength(1);
      await second.query("SELECT pg_terminate_backend($1)", [
        requiredValue(backend.rows[0], "required operation value").pid,
      ]);
      await lease.save(value);
    }),
  ).rejects.toBeDefined();
  await b.exclusive(key, async (lease) => {
    await lease.save(value);
  });
  expect(await a.read(key)).toEqual(value);
}
/** Creates independent applications sharing only their durable store and sealing key. */
export async function createAppInstances(pools: Pool[], secret: string) {
  return await Promise.all(
    pools.map((pool) =>
      Integration.create({
        url: "http://localhost:8000",
        appOrigin: "http://localhost:3000",
        keys: [secret],
        store: new PostgresSessionStore(pool, 2000),
        allowInsecureDevelopment: true,
        fetch: integrationFetch,
      }),
    ),
  );
}
/** Counts usable credentials without relying on bootstrap lock winner order. */
export async function verifyCredentialCount(pool: Pool, secret: string) {
  const sealer = await SessionSealer.create([secret]);
  const rows = await pool.query<{
    key: string;
    sealed: string;
  }>("SELECT key, sealed FROM nelcota_next.sessions");
  const credentials = await countCredentials(rows.rows, sealer);
  expect(credentials).toBe(1);
}
