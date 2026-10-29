import { randomBytes } from "node:crypto";

import { Integration, type CookieWriter, type SessionOptions } from "../src/context.js";
import { promiseResult } from "../src/lifecycle/promise-result.js";
import { DevelopmentSessionStore } from "../src/memory-store.js";

const user = {
  id: "user-one",
  email: "one@example.test",
  email_confirmed_at: null,
  user_metadata: {},
  created_at: "",
  last_sign_in_at: null,
};

const session = (token = "access-one", refresh = "refresh-one") => ({
  access_token: token,
  refresh_token: refresh,
  token_type: "bearer",
  expires_in: 900,
  expires_at: Math.floor(Date.now() / 1000) + 900,
  user,
});

class Jar implements CookieWriter {
  readonly values = new Map<string, string>();
  readonly writes: { name: string; value: string; options: Parameters<CookieWriter["set"]>[2] }[] =
    [];
  get(name: string): { value: string } | undefined {
    const value = this.values.get(name);
    return value != null && value !== "" ? { value } : undefined;
  }
  set(name: string, value: string, options: Parameters<CookieWriter["set"]>[2]): void {
    this.writes.push({ name, value, options });
    if (options.maxAge === 0) {
      this.values.delete(name);
      return;
    }
    this.values.set(name, value);
  }
}

const post = () =>
  new Request("http://localhost:3000/auth/login", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
  });

async function setup(overrides: Partial<SessionOptions> = {}) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const store = new DevelopmentSessionStore();
  const integration = await Integration.create({
    url: "http://localhost:8000",
    appOrigin: "http://localhost:3000",
    keys: [randomBytes(32).toString("base64url")],
    store,
    allowInsecureDevelopment: true,
    fetch: (url, init = {}) => {
      return promiseResult(() => {
        requests.push({ url: new URL(url instanceof Request ? url.url : url), init });
        const path = new URL(url instanceof Request ? url.url : url).pathname;
        if (path === "/auth/v1/token") return Response.json(session());
        return Response.json(path === "/auth/v1/user" ? user : []);
      });
    },
    ...overrides,
  });
  return { integration, requests, store, jar: new Jar() };
}

const credentials = { email: "one@example.test", password: "fixture-password" };
export { user, session, Jar, post, setup, credentials };
