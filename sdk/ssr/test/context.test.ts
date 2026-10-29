import { randomBytes } from "node:crypto";

import { expect, it, vi } from "vitest";

import { Integration } from "../src/context.js";
import { DevelopmentSessionStore } from "../src/memory-store.js";
import { requiredValue } from "../src/required-value.js";
import { user, post, setup, credentials } from "./context-fixtures.js";

it("request-owned sessions: keeps credentials in encrypted storage and only an opaque HttpOnly cookie in the browser", async () => {
  const { integration, jar, store } = await setup();
  const ownership = vi.spyOn(store, "exclusive");
  const result = await integration.write(
    jar,
    post(),
    async (context) => await context.auth.signInWithPassword(credentials),
  );
  expect(JSON.stringify(result)).not.toMatch(/access-one|refresh-one/);
  expect(result.data?.id).toBe("user-one");
  expect(jar.writes).toHaveLength(1);
  const cookie = requiredValue(jar.writes[0], "published cookie");
  expect(cookie.value).toHaveLength(43);
  expect(cookie.options.httpOnly).toBe(true);
  expect(cookie.options.sameSite).toBe("lax");
  const saved = await store.read(requiredValue(ownership.mock.calls[0], "recorded request")[0]);
  expect(saved?.sealed).not.toMatch(/access-one|refresh-one/);
  await integration.read(jar, async (context) => {
    expect((await context.getUser()).data?.id).toBe("user-one");
  });
  expect(jar.writes).toHaveLength(1);
});

it("request-owned sessions: preserves accepted login when a Next redirect throws", async () => {
  const { integration, jar } = await setup();
  const redirect = new Error("NEXT_REDIRECT");
  await expect(
    integration.write(jar, post(), async (context) => {
      await context.auth.signInWithPassword(credentials);
      throw redirect;
    }),
  ).rejects.toBe(redirect);
  expect(jar.writes).toHaveLength(1);
  await integration.read(jar, async (context) => {
    expect((await context.getUser()).data?.id).toBe("user-one");
  });
});

it("request-owned sessions: rejects unsafe origin before HTTP, cookies or session mutation", async () => {
  const { integration, requests, jar } = await setup();
  await expect(
    integration.write(
      jar,
      new Request("http://localhost:3000/auth/login", {
        method: "POST",
        headers: { origin: "https://evil.test" },
      }),
      async (context) => await context.auth.signInWithPassword(credentials),
    ),
  ).rejects.toMatchObject({ code: "csrf" });
  expect(requests).toHaveLength(0);
  expect(jar.writes).toHaveLength(0);
});

it("request-owned sessions: refuses component writes and use after the request ends", async () => {
  const { integration, requests, jar } = await setup();
  let late: (() => Promise<unknown>) | undefined;
  await integration.read(jar, async (context) => {
    const result = await context.client.rpc("mutate");
    expect(result.error?.code).toBe("read_only");
    late = context.getUser;
  });
  await expect(late?.()).rejects.toMatchObject({ code: "closed_context" });
  expect(requests).toHaveLength(0);
});

it("request-owned sessions: surfaces failed cookie writes and never exposes encryption keys in inspection", async () => {
  const { integration, jar } = await setup();
  jar.set = () => {
    throw new Error("cookie store is read-only");
  };
  await expect(
    integration.write(
      jar,
      post(),
      async (context) => await context.auth.signInWithPassword(credentials),
    ),
  ).rejects.toMatchObject({
    code: "session_store",
    message: "Session cookie publication failed",
  });
  expect(JSON.stringify(integration)).toBe("{}");
});

it("request-owned sessions: never sends cookies to the API and forces private uncached fetches", async () => {
  const { integration, requests, jar } = await setup();
  await integration.write(jar, post(), (context) => context.auth.signInWithPassword(credentials));
  await integration.read(jar, (context) => context.getUser());
  for (const request of requests) {
    expect(request.init.cache).toBe("no-store");
    expect(request.init.redirect).toBe("error");
    expect(new Headers(request.init.headers).has("cookie")).toBe(false);
  }
});

it("request-owned sessions: rejects production memory stores and remote development origins", async () => {
  const keys = [randomBytes(32).toString("base64url")],
    store = new DevelopmentSessionStore();
  await expect(
    Integration.create({ url: "https://api.test", appOrigin: "https://app.test", keys, store }),
  ).rejects.toMatchObject({ code: "configuration" });
  await expect(
    Integration.create({
      url: "https://api.test",
      appOrigin: "https://app.test",
      keys,
      store,
      allowInsecureDevelopment: true,
    }),
  ).rejects.toMatchObject({ code: "configuration" });
});

it("binds OAuth callbacks to the initiating browser and consumes state exactly once", async () => {
  const { integration, jar, requests } = await setup();
  const started = await integration.write(jar, post(), (context) =>
    context.auth.startOAuth({ provider: "github", returnTo: "/profile" }),
  );
  expect(started.error).toBeNull();
  const redirect = new URL(
    requiredValue(
      new URL(requiredValue(started.data, "response data").url).searchParams.get("redirect_to"),
      "response data",
    ),
  );
  const state = requiredValue(redirect.searchParams.get("state"), "URL parameter");
  const callback = (nonce: string) =>
    new Request(
      `http://localhost:3000/auth/callback?code=fixture&state=${encodeURIComponent(nonce)}`,
    );
  for (const nonce of ["a".repeat(43), "é".repeat(43)]) {
    // oxlint-disable-next-line no-await-in-loop -- Each rejected callback must leave the same browser state unconsumed.
    await expect(
      integration.write(
        jar,
        callback(nonce),
        (context) => context.auth.exchangeCode("fixture"),
        true,
      ),
    ).rejects.toMatchObject({ code: "csrf" });
  }
  expect(requests).toHaveLength(0);
  const exchanged = await integration.write(
    jar,
    callback(state),
    (context) => context.auth.exchangeCode("fixture"),
    true,
  );
  expect(exchanged.data?.returnTo).toBe("/profile");
  expect(exchanged.data?.user.id).toBe(user.id);
  expect(requests).toHaveLength(1);
  await expect(
    integration.write(
      jar,
      callback(state),
      (context) => context.auth.exchangeCode("fixture"),
      true,
    ),
  ).rejects.toMatchObject({ code: "csrf" });
  expect(requests).toHaveLength(1);
});

it("refuses ordinary mutations and data writes in a callback GET", async () => {
  const { integration, jar, requests } = await setup();
  const request = new Request("http://localhost:3000/auth/callback");
  await expect(
    integration.write(
      jar,
      request,
      (context) => context.auth.signInWithPassword(credentials),
      true,
    ),
  ).rejects.toMatchObject({ code: "csrf" });
  await integration.write(
    jar,
    request,
    async (context) => {
      expect((await context.client.rpc("mutate")).error?.code).toBe("read_only");
    },
    true,
  );
  expect(requests).toHaveLength(0);
});

it("isolates cookie namespaces when applications share the same store and key", async () => {
  const first = await setup();
  const second = await setup({ store: first.store, appOrigin: "http://localhost:3001" });
  await first.integration.write(first.jar, post(), (context) =>
    context.auth.signInWithPassword(credentials),
  );
  await second.integration.read(first.jar, async (context) => {
    expect(context.hasSession).toBe(false);
    expect((await context.getUser()).error?.code).toBe("session_missing");
  });
  expect(second.requests).toHaveLength(0);
});

it("drains accepted auth operations in FIFO order and rejects late callers", async () => {
  const { integration, jar, requests } = await setup();
  let late: (() => Promise<unknown>) | undefined;
  await integration.write(jar, post(), async (context) => {
    const first = context.auth.signInWithPassword(credentials);
    const second = context.auth.signInWithPassword(credentials);
    late = () => context.auth.signInWithPassword(credentials);
    await first;
    await second;
  });
  expect(requests).toHaveLength(2);
  await expect(late?.()).rejects.toMatchObject({ code: "closed_context" });
  expect(requests).toHaveLength(2);
});
