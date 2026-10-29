import { randomBytes } from "node:crypto";

import { Integration, type CookieWriter, type SessionOptions } from "../src/context.js";
import { promiseResult } from "../src/lifecycle/promise-result.js";
import { DevelopmentSessionStore } from "../src/memory-store.js";

const origin = "http://localhost:3000",
  api = "http://localhost:8000";

const user = {
  id: "user-one",
  email: "one@example.test",
  email_confirmed_at: null,
  user_metadata: {},
  created_at: "",
  last_sign_in_at: null,
};

class Jar implements CookieWriter {
  readonly values = new Map<string, string>();
  get(name: string): { value: string } | undefined {
    const value = this.values.get(name);
    return value != null && value !== "" ? { value } : undefined;
  }
  set(name: string, value: string, options: Parameters<CookieWriter["set"]>[2]): void {
    if (options.maxAge === 0) {
      this.values.delete(name);
      return;
    }
    this.values.set(name, value);
  }
}

const post = () => new Request(`${origin}/auth/login`, { method: "POST", headers: { origin } });

interface Sent {
  url: URL;
  redirect: RequestRedirect | undefined;
  headers: Headers;
}

async function setup(routes: Record<string, string>, overrides: Partial<SessionOptions> = {}) {
  const sent: Sent[] = [];
  const integration = await Integration.create({
    url: api,
    appOrigin: origin,
    keys: [randomBytes(32).toString("base64url")],
    store: new DevelopmentSessionStore(),
    allowInsecureDevelopment: true,
    fetch: (input, init = {}) => {
      return promiseResult(() => {
        const url = new URL(input instanceof Request ? input.url : input);
        sent.push({ url, redirect: init.redirect, headers: new Headers(init.headers) });
        if (url.pathname === "/auth/v1/token")
          return Response.json({
            access_token: "access-one",
            refresh_token: "refresh-one",
            token_type: "bearer",
            expires_in: 900,
            expires_at: Math.floor(Date.now() / 1000) + 900,
            user,
          });
        if (url.pathname === "/auth/v1/user") return Response.json(user);
        const location = routes[url.href];
        if (location !== undefined)
          return new Response("moved", { status: 302, headers: { location } });
        return new Response(`object from ${url.origin}`);
      });
    },
    ...overrides,
  });
  const jar = new Jar();
  await integration.write(jar, post(), (context) =>
    context.auth.signInWithPassword({ email: "one@example.test", password: "fixture-password" }),
  );
  sent.length = 0;
  return { integration, jar, sent };
}

const object = `${api}/storage/v1/object/assets/report.pdf`;

const presigned = "https://s3.example.test/bucket/report.pdf?X-Amz-Signature=fixture";
export { origin, api, user, Jar, post, setup, object, presigned };
