import { describe, expect, it, vi } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { DevelopmentSessionStore } from "../src/memory-store.js";
import { requiredValue } from "../src/required-value.js";
import { newSessionId } from "../src/sealing/seal.js";
import type { SessionStore } from "../src/store.js";
import { user, session, Jar, post, setup, credentials } from "./context-fixtures.js";

it("session fixation: rotates the ID when a login replaces an existing session and leaves only a tombstone", async () => {
  const { integration, jar } = await setup();
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const first = requiredValue(jar.writes.at(-1), "published cookie");
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const second = requiredValue(jar.writes.at(-1), "published cookie");
  expect(second.name).toBe(first.name);
  expect(second.value).not.toBe(first.value);
  const stale = new Jar();
  stale.values.set(first.name, first.value);
  await integration.read(stale, (context) => {
    return promiseResult(() => {
      expect(context.hasSession).toBe(false);
      expect(context.superseded).toBe(true);
    });
  });
  await integration.read(jar, (context) => {
    return promiseResult(() => {
      expect(context.hasSession).toBe(true);
    });
  });
});

it("session fixation: rotates the pre-login OAuth ID on code exchange but keeps it for non-identity writes", async () => {
  const { integration, jar } = await setup();
  const started = await integration.write(jar, post(), (context) =>
    context.auth.startOAuth({ provider: "github" }),
  );
  const initial = requiredValue(jar.writes.at(-1), "published cookie").value;
  await integration.write(jar, post(), () => promiseResult(() => undefined));
  expect(requiredValue(jar.writes.at(-1), "published cookie").value).toBe(initial);
  const redirect = new URL(
    requiredValue(
      new URL(requiredValue(started.data, "response data").url).searchParams.get("redirect_to"),
      "response data",
    ),
  );
  const exchanged = await integration.write(
    jar,
    new Request(
      `http://localhost:3000/auth/callback?code=fixture&state=${redirect.searchParams.get("state")}`,
    ),
    (context) => context.auth.exchangeCode("fixture"),
    true,
  );
  expect(exchanged.error).toBeNull();
  expect(requiredValue(jar.writes.at(-1), "published cookie").value).not.toBe(initial);
  expect(requiredValue(jar.writes.at(-1), "published cookie").options.maxAge).toBeGreaterThan(0);
});

it("session fixation: keeps a row-less (bootstrap) cookie but clears a malformed one when the write publishes nothing", async () => {
  const { integration, jar, store } = await setup();
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  const name = requiredValue(jar.writes[0], "published cookie").name;
  const ownership = vi.spyOn(store, "exclusive");
  const stranger = new Jar();
  stranger.values.set(name, newSessionId());
  await integration.write(stranger, post(), () => promiseResult(() => undefined));
  expect(stranger.writes).toHaveLength(0);
  expect(
    await store.read(requiredValue(ownership.mock.calls[0], "recorded request")[0]),
  ).toBeNull();
  const malformed = new Jar();
  malformed.values.set(name, "not-a-session-id");
  await integration.write(malformed, post(), () => promiseResult(() => undefined));
  expect(malformed.writes).toHaveLength(1);
  expect(requiredValue(malformed.writes[0], "published cookie").options.maxAge).toBe(0);
});

/** Signs in with a session that has `left` seconds of validity, then makes refresh fail with 503. */
// Whole seconds: `left = 1` could leave a few milliseconds and let the token
// expire mid-test. 3 s stays inside the 5 s sign-out renewal skew.
async function expiring(left = 3) {
  const response: { refresh?: Response } = {};
  const requests: string[] = [];
  const fixture = await setup({
    fetch: (url) => {
      return promiseResult(() => {
        const target = new URL(url instanceof Request ? url.url : url);
        requests.push(`${target.pathname}${target.search}`);
        if (target.searchParams.get("grant_type") === "refresh_token")
          return response.refresh ?? Response.json({}, { status: 500 });
        if (target.pathname === "/auth/v1/token")
          return Response.json({
            ...session(),
            expires_in: 60,
            expires_at: Math.floor(Date.now() / 1000) + left,
          });
        return Response.json(target.pathname === "/auth/v1/user" ? user : null);
      });
    },
  });
  await fixture.integration.write(fixture.jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  response.refresh = Response.json(
    { code: "unavailable", message: "Unavailable" },
    { status: 503 },
  );
  requests.length = 0;
  return { ...fixture, requests };
}
it("refresh outages > revokes a still-valid token and signs out locally while refresh returns 503", async () => {
  const { integration, jar, requests } = await expiring();
  const result = await integration.write(jar, post(), (context) => context.auth.signOut());
  expect(result.error).toBeNull();
  expect(requests.at(-1)).toBe("/auth/v1/logout");
  expect(jar.writes.at(-1)?.options.maxAge).toBe(0);
  expect(jar.values.size).toBe(0);
  await integration.read(jar, (context) => {
    return promiseResult(() => {
      expect(context.hasSession).toBe(false);
    });
  });
});
it("refresh outages > surfaces the 503 and still signs out locally when the token already expired", async () => {
  const { integration, jar, requests } = await expiring(-30);
  const result = await integration.write(jar, post(), (context) => context.auth.signOut());
  expect(result.error?.status).toBe(503);
  expect(requests.every((path) => path.includes("grant_type=refresh_token"))).toBe(true);
  expect(jar.writes.at(-1)?.options.maxAge).toBe(0);
  expect(jar.values.size).toBe(0);
  await integration.read(jar, (context) => {
    return promiseResult(() => {
      expect(context.hasSession).toBe(false);
    });
  });
});
it("refresh outages > still runs sign-in when the pre-refresh fails", async () => {
  const { integration, jar } = await expiring();
  const result = await integration.write(jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  expect(result.data?.id).toBe("user-one");
});

describe("lease budget", () => {
  const bounded = (inner: DevelopmentSessionStore, budget: number): SessionStore => ({
    durability: "development",
    read: (key) => inner.read(key),
    exclusive: (key, work) =>
      inner.exclusive(key, (lease) =>
        work({
          signal: lease.signal,
          deadline: Date.now() + budget,
          load: lease.load.bind(lease),
          save: lease.save.bind(lease),
          remove: lease.remove.bind(lease),
          rotate: lease.rotate.bind(lease),
        }),
      ),
  });
  it("refuses an auth request that cannot finish inside the lease", async () => {
    const { integration, jar, requests } = await setup({
      store: bounded(new DevelopmentSessionStore(), 50),
    });
    const result = await integration.write(jar, post(), (context) =>
      context.auth.signInWithPassword(credentials),
    );
    expect(result.error?.code).toBe("lease_exhausted");
    expect(requests).toHaveLength(0);
    expect(jar.writes).toHaveLength(0);
  });
  it("shortens each auth deadline to the remaining lease budget", async () => {
    let aborted = 0;
    const { integration, jar } = await setup({
      store: bounded(new DevelopmentSessionStore(), 300),
      fetch: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = Date.now();
            // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any value; preserve the caller's cancellation identity.
            reject(init.signal?.reason);
          });
        }),
    });
    const started = Date.now();
    const result = await integration.write(jar, post(), (context) =>
      context.auth.signInWithPassword(credentials),
    );
    expect(result.error?.code).toBe("timeout");
    expect(aborted - started).toBeLessThan(2000);
  });
});
