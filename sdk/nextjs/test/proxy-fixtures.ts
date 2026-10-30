import type { Integration, SessionOptions } from "@nelcota/ssr";
import { expect } from "vitest";

import { Exchange } from "./cookie-exchange.js";
import { promiseResult } from "./promise-result.js";

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

/** The fixture user name is the local part of the submitted email. */
function requestUser(init: RequestInit): string {
  if (typeof init.body !== "string") throw new TypeError("Expected a JSON request body");
  const value: unknown = JSON.parse(init.body);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected an object request body");
  const email = (value as Record<string, unknown>)["email"];
  if (typeof email !== "string") throw new TypeError("Expected a fixture email");
  const [user = ""] = email.split("@");
  return user;
}

const userFor = (name: string) => ({
  id: `user-${name}`,
  email: `${name}@example.test`,
  email_confirmed_at: null,
  user_metadata: {},
  created_at: "",
  last_sign_in_at: null,
});

const authFetch: NonNullable<SessionOptions["fetch"]> = (url, init = {}) => {
  return promiseResult(() => {
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

function bootstrapped(app: Integration<unknown>): Promise<Browser> {
  return promiseResult(() => {
    const browser = new Browser(),
      exchange = browser.request();
    expect(app.bootstrap(exchange, exchange)).toBe(true);
    browser.receive(exchange);
    return browser;
  });
}

export { origin, api, post, authFetch, login, bootstrapped };
