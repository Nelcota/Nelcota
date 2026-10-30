import { randomBytes } from "node:crypto";

import { expect } from "vitest";

import { Integration, type SessionOptions } from "../src/context.js";
import { DevelopmentSessionStore } from "../src/memory-store.js";
import { PostgresSessionStore } from "../src/postgres.js";
import { SessionSealer } from "../src/sealing/seal.js";
import type { SessionLease, SessionStore } from "../src/store.js";
import { FakePostgres } from "./fake-postgres.js";
import { Exchange } from "./postgres-integration-fixtures.js";
import { requestUser } from "./request-values.js";

class Browser {
  readonly cookies = new Map<string, string>();
  request(): Exchange {
    return new Exchange(new Map(this.cookies));
  }
  receive(exchange: Exchange): void {
    for (const { name, value, options } of exchange.sets) {
      if (options.maxAge === 0) this.cookies.delete(name);
      if (options.maxAge !== 0) this.cookies.set(name, value);
    }
  }
}

const origin = "http://localhost:3000",
  api = "http://localhost:8000";

const post = () => new Request(`${origin}/auth/login`, { method: "POST", headers: { origin } });

const userFor = (name: string) => ({
  id: `user-${name}`,
  email: `${name}@example.test`,
  email_confirmed_at: null,
  user_metadata: {},
  created_at: "",
  last_sign_in_at: null,
});

const authFetch: NonNullable<SessionOptions["fetch"]> = (url, init = {}) => {
  return Promise.resolve().then(() => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.pathname === "/auth/v1/token") {
      const name = requestUser(init);
      return Response.json({
        access_token: `access-${name}`,
        refresh_token: `refresh-${name}`,
        token_type: "bearer",
        expires_in: 900,
        expires_at: Math.floor(Date.now() / 1000) + 900,
        user: userFor(name),
      });
    }
    if (target.pathname === "/auth/v1/user") {
      const token = new Headers(init.headers).get("authorization")?.replace("Bearer access-", "");
      return token != null && token !== ""
        ? Response.json(userFor(token))
        : Response.json({ code: "invalid_token", message: "No token" }, { status: 401 });
    }
    if (target.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    return Response.json([]);
  });
};

const login = (name: string) => ({ email: `${name}@example.test`, password: "fixture-password" });

interface Fixture {
  /** Two integrations: separate app instances that share one session store backend. */
  apps: [Integration<unknown>, Integration<unknown>];
  keys: Set<string>;
  read(key: string): Promise<{ sealed: string; expiresAt: number } | null>;
  secret: string;
}

function tracked(store: SessionStore, keys: Set<string>): SessionStore {
  const wrap = (lease: SessionLease): SessionLease => ({
    signal: lease.signal,
    get deadline() {
      return lease.deadline;
    },
    load: () => lease.load(),
    save: (value) => lease.save(value),
    remove: () => lease.remove(),
    rotate: async (next, retain) => {
      keys.add(next);
      await lease.rotate(next, retain);
    },
  });
  return {
    durability: store.durability,
    read: (key) => store.read(key),
    exclusive: (key, work) => {
      keys.add(key);
      return store.exclusive(key, (lease) => work(wrap(lease)));
    },
  };
}

const appOptions = (store: SessionStore, secret: string) => ({
  url: api,
  appOrigin: origin,
  keys: [secret],
  store,
  allowInsecureDevelopment: true,
  fetch: authFetch,
});

async function memoryFixture(): Promise<Fixture> {
  const store = new DevelopmentSessionStore(),
    secret = randomBytes(32).toString("base64url"),
    keys = new Set<string>();
  const shared = tracked(store, keys);
  return {
    apps: [
      await Integration.create(appOptions(shared, secret)),
      await Integration.create(appOptions(shared, secret)),
    ],
    keys,
    read: (key) => store.read(key),
    secret,
  };
}

async function postgresFixture(): Promise<Fixture> {
  const database = new FakePostgres(),
    secret = randomBytes(32).toString("base64url"),
    keys = new Set<string>();
  // Separate store instances model separate processes sharing one database.
  const first = new PostgresSessionStore(database.pool(), 200, 2000),
    second = new PostgresSessionStore(database.pool(), 200, 2000);
  return {
    apps: [
      await Integration.create(appOptions(tracked(first, keys), secret)),
      await Integration.create(appOptions(tracked(second, keys), secret)),
    ],
    keys,
    read: (key) => first.read(key),
    secret,
  };
}

async function credentialRows(fixture: Fixture): Promise<number> {
  const sealer = await SessionSealer.create([fixture.secret]);
  let count = 0;
  for (const key of fixture.keys) {
    // oxlint-disable-next-line no-await-in-loop -- Inspect persisted lineage rows in order without adding concurrent store reads.
    const row = await fixture.read(key);
    if (row == null) continue;
    // oxlint-disable-next-line no-await-in-loop -- Inspect persisted lineage rows in order without adding concurrent store reads.
    const state = await sealer
      .open(row.sealed, `nelcota-next/v1\0${origin}\0${api}/\0${key}`)
      .catch(() => null);
    if (state?.session != null && state.session !== "") count++;
  }
  return count;
}

async function whoAmI(
  app: Integration<unknown>,
  browser: Browser,
): Promise<{ user: string | null; superseded: boolean }> {
  return await app.read(browser.request(), async (context) => ({
    user: (await context.getUser()).data?.id ?? null,
    superseded: context.superseded,
  }));
}

function bootstrapped(app: Integration<unknown>): Promise<Browser> {
  return Promise.resolve().then(() => {
    const browser = new Browser(),
      exchange = browser.request();
    expect(app.bootstrap(exchange, exchange)).toBe(true);
    browser.receive(exchange);
    return browser;
  });
}
export {
  Browser,
  post,
  login,
  memoryFixture,
  postgresFixture,
  credentialRows,
  whoAmI,
  bootstrapped,
};
