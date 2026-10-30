import { randomBytes } from "node:crypto";

import { DevelopmentSessionStore } from "@nelcota/ssr/testing";
import { beforeEach, expect, it, vi } from "vitest";

import { createNelcotaNext } from "../src/server.js";
import { promiseResult } from "./promise-result.js";

const APP_ORIGIN = "http://localhost:3000";
// The request scope Next would expose through next/headers for the current call.
const scope = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  writes: [] as string[],
  headers: new Headers(),
}));
vi.mock("next/headers.js", () => ({
  cookies: async () =>
    await Promise.resolve({
      get: (name: string) => {
        const value = scope.jar.get(name);
        return value === undefined ? undefined : { name, value };
      },
      set: (name: string, value: string) => {
        scope.writes.push(name);
        scope.jar.set(name, value);
      },
    }),
  headers: async () => await Promise.resolve(scope.headers),
}));

beforeEach(() => {
  scope.jar.clear();
  scope.writes.length = 0;
  scope.headers = new Headers();
});
async function setup(basePath?: string) {
  const fetch = vi.fn(() =>
    promiseResult(() =>
      Response.json({ code: "unexpected", message: "Unexpected" }, { status: 500 }),
    ),
  );
  const nelcota = await createNelcotaNext({
    url: "http://localhost:8000",
    appOrigin: APP_ORIGIN,
    keys: [randomBytes(32).toString("base64url")],
    store: new DevelopmentSessionStore(),
    allowInsecureDevelopment: true,
    fetch,
    ...(basePath === undefined ? {} : { basePath }),
  });
  return { nelcota, fetch };
}

it("exposes the validated origin and base path for absolute redirects", async () => {
  const { nelcota } = await setup("/app");
  expect(nelcota.origin).toBe(APP_ORIGIN);
  expect(nelcota.basePath).toBe("/app");
  expect((await setup()).nelcota.basePath).toBe("");
});

it("refuses a Server Action from a foreign or missing Origin before any work or HTTP", async () => {
  const { nelcota, fetch } = await setup();
  const work = vi.fn(async () => await Promise.resolve("ran"));
  for (const origin of ["https://evil.test", null]) {
    scope.headers = new Headers(origin === null ? {} : { origin });
    // oxlint-disable-next-line no-await-in-loop -- Each Origin case uses the shared request scope in turn.
    await expect(nelcota.action(work)).rejects.toMatchObject({ code: "csrf" });
  }
  expect(work).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(scope.writes).toEqual([]);
});

it("runs a same-origin Server Action without the Host header defining trust", async () => {
  const { nelcota } = await setup();
  scope.headers = new Headers({ origin: APP_ORIGIN, host: "evil.test" });
  expect(await nelcota.action(async () => await Promise.resolve("ran"))).toBe("ran");
});

it("sends Route Handler responses with private, uncacheable headers", async () => {
  const { nelcota } = await setup();
  const response = await nelcota.route(
    new Request(`${APP_ORIGIN}/api/thing`, { method: "POST", headers: { origin: APP_ORIGIN } }),
    async () =>
      await Promise.resolve(
        new Response("ok", { headers: { vary: "Accept", "cache-control": "public, max-age=60" } }),
      ),
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("vary")).toContain("Cookie");
  expect(response.headers.get("vary")).toContain("Accept");
  expect(await response.text()).toBe("ok");
  await expect(
    nelcota.route(
      new Request(`${APP_ORIGIN}/api/thing`, { method: "POST" }),
      async () => await Promise.resolve(new Response("unreachable")),
    ),
  ).rejects.toMatchObject({ code: "csrf" });
});

it("keeps Server Component reads read-only: no data mutation, HTTP or cookie writes", async () => {
  const { nelcota, fetch } = await setup();
  const result = await nelcota.server(async ({ client, hasSession }) => {
    expect(hasSession).toBe(false);
    expect("auth" in client).toBe(false);
    return await client.rpc("mutate");
  });
  expect(result.error?.code).toBe("read_only");
  expect(fetch).not.toHaveBeenCalled();
  expect(scope.writes).toEqual([]);
});

it("resets a local session only from a same-origin POST, privately", async () => {
  const { nelcota } = await setup();
  await expect(
    nelcota.forgetLocalSession(
      new Request(`${APP_ORIGIN}/api/reset`, {
        method: "POST",
        headers: { origin: "https://evil.test" },
      }),
    ),
  ).rejects.toMatchObject({ code: "csrf" });
  const response = await nelcota.forgetLocalSession(
    new Request(`${APP_ORIGIN}/api/reset`, { method: "POST", headers: { origin: APP_ORIGIN } }),
  );
  expect(response.status).toBe(204);
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
});
