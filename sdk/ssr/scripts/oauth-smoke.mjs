// Called by the ignored, explicitly selected Next SDK OAuth server contract.
// GitHub token/profile endpoints are local fixtures; Nelcota and PKCE are real.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { Integration } from "../dist/context.js";
import { DevelopmentSessionStore } from "../dist/memory-store.js";
import { fixtureString } from "./fixture-values.mjs";
const requestTimeoutInMs = 10000;

const api = process.env.NELCOTA_NEXT_OAUTH_TEST_URL;
if (
  api == null ||
  api === "" ||
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(api).hostname) === false
)
  throw new Error("Explicit disposable loopback backend required");
const origin = "http://localhost:3000";
class Jar {
  /** @type {Map<string, string>} */
  values = new Map();
  /** @param {string} name */
  get(name) {
    const value = this.values.get(name);
    return value === undefined ? undefined : { value };
  }
  /** @param {string} name
   * @param {string} value
   * @param {Parameters<import("../dist/context.js").CookieWriter["set"]>[2]} options */
  set(name, value, options) {
    if (options.maxAge === 0) {
      this.values.delete(name);
      return;
    }
    this.values.set(name, value);
  }
}
const jar = new Jar();
const integration = await Integration.create({
  url: api,
  appOrigin: origin,
  keys: [randomBytes(32).toString("base64url")],
  store: new DevelopmentSessionStore(),
  allowInsecureDevelopment: true,
});
const start = await integration.write(
  jar,
  new Request(`${origin}/login`, { method: "POST", headers: { origin } }),
  (context) => context.auth.startOAuth({ provider: "github", returnTo: "/profile" }),
);
assert.equal(start.error, null);
assert.notEqual(start.data, null);
const authorization = await fetch(start.data.url, {
  redirect: "manual",
  signal: AbortSignal.timeout(requestTimeoutInMs),
});
assert.equal(authorization.status, 303);
const provider = new URL(fixtureString(authorization.headers.get("location")));
// Do not contact the external provider. The harness has already arranged local
// token/profile responses for this code and the generated provider state.
const providerCallback = new URL("/auth/v1/callback", api);
providerCallback.searchParams.set("code", "good-code");
providerCallback.searchParams.set("state", fixtureString(provider.searchParams.get("state")));
const authorized = await fetch(providerCallback, {
  redirect: "manual",
  signal: AbortSignal.timeout(requestTimeoutInMs),
});
assert.equal(authorized.status, 303);
const callback = new Request(fixtureString(authorized.headers.get("location")));
const code = fixtureString(new URL(callback.url).searchParams.get("code"));
await assert.rejects(
  integration.write(new Jar(), callback, (context) => context.auth.exchangeCode(code), true),
  { code: "csrf" },
);
const result = await integration.write(
  jar,
  callback,
  (context) => context.auth.exchangeCode(code),
  true,
);
assert.equal(result.error, null);
assert.notEqual(result.data, null);
assert.equal(result.data.user.email, "next-oauth@example.test");
assert.equal(result.data.returnTo, "/profile");
assert(JSON.stringify(result).includes("refresh_token") === false);
assert.equal(
  (await integration.read(jar, (context) => context.getUser())).data?.email,
  "next-oauth@example.test",
);
await assert.rejects(
  integration.write(jar, callback, (context) => context.auth.exchangeCode(code), true),
  { code: "csrf" },
);
console.log(
  "PASS: Next SDK -> real Nelcota -> local GitHub endpoints -> bound callback -> real PKCE exchange -> verified user; foreign browser and callback replay refused",
);
