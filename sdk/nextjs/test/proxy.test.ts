import { randomBytes } from "node:crypto";

import { Integration } from "@nelcota/ssr";
import { DevelopmentSessionStore } from "@nelcota/ssr/testing";
import { NextRequest } from "next/server.js";
import { expect, it, vi } from "vitest";

import { createNelcotaProxy } from "../src/proxy.js";
import { promiseResult } from "./promise-result.js";
import { requiredValue } from "./required-value.js";

async function setup(basePath?: string) {
  const fetch = vi.fn(() =>
    promiseResult(() =>
      Response.json({ code: "invalid_token", message: "Expired" }, { status: 401 }),
    ),
  );
  const options = {
    url: "http://localhost:8000",
    appOrigin: "http://localhost:3000",
    keys: [randomBytes(32).toString("base64url")],
    store: new DevelopmentSessionStore(),
    allowInsecureDevelopment: true,
    fetch,
    ...(basePath != null && basePath !== "" ? { basePath } : {}),
  };
  return {
    options,
    fetch,
    proxy: await createNelcotaProxy(options, { protectedPaths: ["/profile", "/auth/private"] }),
  };
}
it("redirects anonymous protected pages to a configured origin without fetching auth", async () => {
  const { proxy, fetch } = await setup();
  const response = await proxy(
    new NextRequest("http://foreign-host.test/profile?tab=one", {
      headers: { "x-forwarded-host": "evil.test" },
    }),
  );
  const target = new URL(requiredValue(response.headers.get("location"), "response header"));
  expect(target.origin).toBe("http://localhost:3000");
  expect(target.pathname).toBe("/login");
  expect(target.searchParams.get("next")).toBe("/profile?tab=one");
  expect(response.headers.get("cache-control")).toContain("private");
  expect(fetch).not.toHaveBeenCalled();
});

it("returns 503 for a failed session store without treating it as a logged-out browser", async () => {
  const { options } = await setup();
  const read = vi
    .spyOn(options.store, "read")
    .mockRejectedValue(new Error("private store diagnostic"));
  const proxy = await createNelcotaProxy(
    { ...options, cookieName: "review-session" },
    { protectedPaths: ["/profile"] },
  );
  const response = await proxy(
    new NextRequest("http://localhost:3000/profile", {
      headers: { cookie: `review-session=${"A".repeat(43)}` },
    }),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.text()).not.toContain("private store diagnostic");
  expect(read).toHaveBeenCalled();
});
it("does not broadly exclude private authentication subroutes", async () => {
  const { proxy } = await setup();
  expect((await proxy(new NextRequest("http://localhost:3000/auth/private"))).status).toBe(303);
  expect(
    (await proxy(new NextRequest("http://localhost:3000/auth/callback"))).headers.get(
      "x-middleware-next",
    ),
  ).toBe("1");
});
it("allows public paths without turning the proxy into the authorization boundary", async () => {
  const { proxy, fetch } = await setup();
  expect(
    (await proxy(new NextRequest("http://localhost:3000/public"))).headers.get("x-middleware-next"),
  ).toBe("1");
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects encoded separators and does not trust malformed paths", async () => {
  const { proxy } = await setup();
  expect((await proxy(new NextRequest("http://localhost:3000/profile%5cprivate"))).status).toBe(
    400,
  );
});
it("preserves service errors instead of converting every failure to a login redirect", async () => {
  const { options, fetch, proxy } = await setup();
  const jar = new Map<string, string>();
  const owner = await Integration.create(options);
  fetch.mockResolvedValueOnce(proxySession());
  await owner.write(
    {
      get: (name) =>
        jar.has(name) ? { value: requiredValue(jar.get(name), "published cookie") } : undefined,
      set: (name, value) => {
        jar.set(name, value);
      },
    },
    new Request("http://localhost:3000/login", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    }),
    (context) =>
      context.auth.signInWithPassword({ email: "one@example.test", password: "fixture-password" }),
  );
  const request = () =>
    new NextRequest("http://localhost:3000/profile", {
      headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") },
    });
  fetch.mockResolvedValueOnce(
    Response.json({ code: "unavailable", message: "Unavailable" }, { status: 503 }),
  );
  expect((await proxy(request())).status).toBe(503);
  fetch.mockResolvedValueOnce(
    Response.json({ code: "denied", message: "Denied" }, { status: 403 }),
  );
  expect((await proxy(request())).status).toBe(403);
  const expired = await proxy(request());
  expect(new URL(requiredValue(expired.headers.get("location"), "response header")).pathname).toBe(
    "/auth/refresh",
  );
});
it("signs out a cookie whose row is unreadable and clears that cookie", async () => {
  const { options, proxy } = await setup();
  const jar = new Map<string, string>();
  const writer = {
    get: (name: string) =>
      jar.has(name) ? { value: requiredValue(jar.get(name), "published cookie") } : undefined,
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  };
  const other = await Integration.create({
    ...options,
    keys: [randomBytes(32).toString("base64url")],
    fetch: () => promiseResult(() => proxySession()),
  });
  await other.write(
    writer,
    new Request("http://localhost:3000/login", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    }),
    (context) =>
      context.auth.signInWithPassword({ email: "one@example.test", password: "fixture-password" }),
  );
  const [name] = [...jar.keys()];
  const response = await proxy(
    new NextRequest("http://localhost:3000/profile", {
      headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") },
    }),
  );
  expect(response.status).toBe(303);
  expect(new URL(requiredValue(response.headers.get("location"), "response header")).pathname).toBe(
    "/login",
  );
  expect(response.cookies.get(requiredValue(name, "name"))?.value).toBe("");
  expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
});
it("prefixes basePath on login redirects", async () => {
  const { proxy } = await setup("/app");
  const target = new URL(
    requiredValue(
      (await proxy(new NextRequest("http://localhost:3000/profile"))).headers.get("location"),
      "required operation value",
    ),
  );
  expect(target.pathname).toBe("/app/login");
  expect(target.searchParams.get("next")).toBe("/profile");
});
it("passes literal percent signs on public paths but keeps protected paths strict", async () => {
  const { proxy } = await setup();
  for (const path of ["/blog/50%25-off", "/blog/%25zz", "/blog/100%2525"])
    expect(
      // oxlint-disable-next-line no-await-in-loop -- Preserve the cookie and request order of the shared proxy fixture.
      (await proxy(new NextRequest(`http://localhost:3000${path}`))).headers.get(
        "x-middleware-next",
      ),
    ).toBe("1");
  for (const path of ["/profile/50%25-off", "/%70rofile/x%25", "/profile%5c%25zz"])
    // oxlint-disable-next-line no-await-in-loop -- Preserve the cookie and request order of the shared proxy fixture.
    expect((await proxy(new NextRequest(`http://localhost:3000${path}`))).status).toBe(400);
  for (const path of ["/%70rofile", "/%2570rofile"])
    // oxlint-disable-next-line no-await-in-loop -- Preserve the cookie and request order of the shared proxy fixture.
    expect((await proxy(new NextRequest(`http://localhost:3000${path}`))).status).toBe(303);
});

function proxySession() {
  return Response.json({
    access_token: "fixture",
    refresh_token: "fixture-refresh",
    token_type: "bearer",
    expires_in: 900,
    expires_at: Math.floor(Date.now() / 1000) + 900,
    user: {
      id: "one",
      email: "one@example.test",
      user_metadata: {},
      created_at: "",
      email_confirmed_at: null,
      last_sign_in_at: null,
    },
  });
}
