import { randomBytes } from "node:crypto";

import { Integration } from "@nelcota/ssr";
import { DevelopmentSessionStore } from "@nelcota/ssr/testing";
import { NextRequest } from "next/server.js";
import { describe, expect, it } from "vitest";

import { createNelcotaProxy } from "../src/proxy.js";
import { origin, api, post, authFetch, login, bootstrapped } from "./proxy-fixtures.js";
import { requiredValue } from "./required-value.js";

describe("proxy bootstrap", () => {
  async function proxy(policy: { bootstrapPaths?: string[] } = {}) {
    const options = {
      url: api,
      appOrigin: origin,
      keys: [randomBytes(32).toString("base64url")],
      store: new DevelopmentSessionStore(),
      allowInsecureDevelopment: true,
      fetch: authFetch,
    };
    return {
      options,
      handle: await createNelcotaProxy(options, { protectedPaths: ["/profile"], ...policy }),
    };
  }
  it("issues a credential-free ID on the login page only when the browser has none", async () => {
    const { handle } = await proxy();
    const issued = await handle(new NextRequest(`${origin}/login`));
    const cookie = requiredValue(issued.cookies.getAll()[0], "published cookie");
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.httpOnly).toBe(true);
    expect(issued.headers.get("cache-control")).toContain("private");
    expect(
      (
        await handle(
          new NextRequest(`${origin}/login`, {
            headers: { cookie: `${cookie.name}=${cookie.value}` },
          }),
        )
      ).cookies.getAll(),
    ).toHaveLength(0);
    expect((await handle(new NextRequest(`${origin}/public`))).cookies.getAll()).toHaveLength(0);
  });
  it("does not clear a superseded cookie on a protected-page redirect", async () => {
    const { options, handle } = await proxy({ bootstrapPaths: ["/login", "/signup"] });
    const app = await Integration.create(options);
    const browser = await bootstrapped(app);
    const first = browser.request();
    await app.write(first, post(), (context) => context.auth.signInWithPassword(login("alice")));
    const second = browser.request();
    await app.write(second, post(), (context) => context.auth.signInWithPassword(login("bob")));
    const { name, value } = requiredValue(first.sets[0], "published cookie");
    const response = await handle(
      new NextRequest(`${origin}/profile`, { headers: { cookie: `${name}=${value}` } }),
    );
    expect(response.status).toBe(303);
    expect(response.cookies.getAll()).toHaveLength(0);
    expect((await handle(new NextRequest(`${origin}/signup`))).cookies.getAll()).toHaveLength(1);
  });
});
