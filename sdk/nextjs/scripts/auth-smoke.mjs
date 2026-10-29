// Invoked by sdk/typescript/scripts/contract.ts --nextjs while its real
// disposable Nelcota/PostgreSQL/STARTTLS Mailpit fixture is alive.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { Integration } from "../../ssr/dist/context.js";
import { PostgresSessionStore } from "../../ssr/dist/postgres.js";
import { SessionSealer, sessionKey } from "../../ssr/dist/sealing/seal.js";
import {
  fixtureArray,
  fixtureEnvironment,
  fixtureObject,
  fixtureString,
} from "./fixture-values.mjs";

const api = fixtureEnvironment("NELCOTA_SDK_TEST_URL");
const mail = fixtureEnvironment("NELCOTA_SDK_TEST_MAIL");
const connectionString = fixtureEnvironment("NELCOTA_SDK_TEST_DATABASE_URL");
for (const value of [api, mail, connectionString]) {
  if (["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname) === false)
    throw new Error("Only explicit loopback contract fixtures are allowed");
}
const origin = "http://localhost:3000";
const key = randomBytes(32).toString("base64url");
const pool = new Pool({
  connectionString,
  max: 8,
  connectionTimeoutMillis: 2000,
  query_timeout: 5000,
});
let poolFailure = false;
pool.on("error", () => {
  poolFailure = true;
});
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
   * @param {Parameters<import("../../ssr/dist/context.js").CookieWriter["set"]>[2]} options */
  set(name, value, options) {
    if (options.maxAge === 0) {
      this.values.delete(name);
      return;
    }
    this.values.set(name, value);
  }
}
const password = () => randomBytes(24).toString("base64url");
const request = () => new Request(`${origin}/api/auth`, { method: "POST", headers: { origin } });
const jar = new Jar();
/** @param {string} address
 * @param {string} page */
async function emailLink(address, page) {
  const requestTimeoutInMs = 2000;
  const delayInMs = 200;

  for (let attempt = 0; attempt < 50; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Poll delivered messages in fixture order and wait before the next mailbox attempt.
    const list = await mailRecord("messages", requestTimeoutInMs);
    const messages = fixtureArray(list.messages).map(fixtureObject);
    // oxlint-disable-next-line no-await-in-loop -- Poll delivered messages in fixture order and wait before the next mailbox attempt.
    const link = await matchingEmail(messages, address, page);
    if (link !== undefined) return link;
    // oxlint-disable-next-line no-await-in-loop -- Poll delivered messages in fixture order and wait before the next mailbox attempt.
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
  }
  throw new Error("The disposable SMTP fixture did not deliver the expected link");
}
/** @param {Record<string, unknown>[]} messages @param {string} address @param {string} page
 * @returns {Promise<URLSearchParams | undefined>} */
async function matchingEmail(messages, address, page) {
  const requestTimeoutInMs = 2000;
  for (const summary of messages.filter((message) =>
    fixtureArray(message.To).some((to) => fixtureObject(to).Address === address),
  )) {
    // oxlint-disable-next-line no-await-in-loop -- Inspect the current matching message before polling the next result.
    const full = await mailRecord(`message/${fixtureString(summary.ID)}`, requestTimeoutInMs);
    const href = fixtureString(full.Text)
      .split(/\s+/)
      .find((word) => word.startsWith(page));
    if (href !== undefined) return new URLSearchParams(new URL(href).hash.slice(1));
  }
  return undefined;
}
/** @param {string} path @param {number} timeoutInMs
 * @returns {Promise<Record<string, unknown>>} */
async function mailRecord(path, timeoutInMs) {
  const response = await fetch(`${mail}/api/v1/${path}`, {
    signal: AbortSignal.timeout(timeoutInMs),
  });
  return fixtureObject(await response.json());
}
try {
  await pool.query(
    await readFile(new URL("../../ssr/sql/session-store.sql", import.meta.url), "utf8"),
  );
  const options = {
    url: api,
    appOrigin: origin,
    keys: [key],
    store: new PostgresSessionStore(pool),
    allowInsecureDevelopment: true,
  };
  const integration = await Integration.create(options);
  const second = await Integration.create({ ...options, store: new PostgresSessionStore(pool) });
  const email = `next-${randomBytes(8).toString("hex")}@example.com`,
    initialPassword = password();
  /** @template T
   * @param {(context: import("../../ssr/dist/context.js").WritableContext<unknown>) => Promise<T>} work */
  const write = (work) => integration.write(jar, request(), work);
  const signedUp = await write((context) =>
    context.auth.signUp({ email, password: initialPassword }),
  );
  assert.equal(signedUp.error, null);
  assert.notEqual(signedUp.data, null);
  assert.equal(signedUp.data.confirmationRequired, false);
  assert(JSON.stringify(signedUp).includes("refresh_token") === false);
  const id = signedUp.data.user.id;
  assert.equal((await second.read(jar, (context) => context.getUser())).data?.id, id);
  const updated = await write((context) =>
    context.auth.updateUser({ data: { display_name: "Next contract" } }),
  );
  assert.equal(updated.error, null);
  assert.notEqual(updated.data, null);
  assert.equal(updated.data.user_metadata.display_name, "Next contract");
  // Expire only local access metadata. The real server must rotate its refresh
  // token, and eight independent request contexts must not replay that rotation.
  const namespace = `${origin}\0${new URL(api).href}`;
  const storedKey = fixtureString(
    await sessionKey(fixtureString([...jar.values.values()][0]), namespace),
  );
  const binding = `nelcota-next/v1\0${origin}\0${new URL(api).href}\0${storedKey}`;
  const sealer = await SessionSealer.create([key]);
  let previousRefresh;
  await options.store.exclusive(storedKey, async (lease) => {
    const row = await lease.load();
    assert(row != null);
    const state = await sealer.open(row.sealed, binding);
    const session = fixtureObject(JSON.parse(fixtureString(state.session)));
    previousRefresh = session.refresh_token;
    session.expires_at = Math.floor(Date.now() / 1000) - 60;
    state.session = JSON.stringify(session);
    await lease.save({ sealed: await sealer.seal(state, binding), expiresAt: state.expiresAt });
  });
  const refreshed = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 !== 0 ? integration : second).write(jar, request(), (context) =>
        context.auth.refresh(),
      ),
    ),
  );
  for (const result of refreshed) {
    assert.equal(result.error, null);
    assert.equal(result.data?.user.id, id);
  }
  const stored = await options.store.read(storedKey);
  assert(stored != null);
  const rotated = await sealer.open(stored.sealed, binding);
  assert.notEqual(
    fixtureObject(JSON.parse(fixtureString(rotated.session))).refresh_token,
    previousRefresh,
  );
  assert.equal((await write((context) => context.auth.requestPasswordReset(email))).error, null);
  const recovery = await emailLink(email, "https://app.example.com/new-password");
  assert.equal(recovery.get("type"), "recovery");
  const nextPassword = password();
  const reset = await write((context) =>
    context.auth.resetPassword({
      token: fixtureString(recovery.get("token")),
      password: nextPassword,
    }),
  );
  assert.equal(reset.error, null);
  assert.notEqual(reset.data, null);
  assert.equal(reset.data.id, id);
  assert(
    (
      await write((context) =>
        context.auth.resetPassword({
          token: fixtureString(recovery.get("token")),
          password: nextPassword,
        }),
      )
    ).error != null,
  );
  assert.equal((await write((context) => context.auth.signOut())).error, null);
  assert.equal(jar.values.size, 0);
  assert(
    (
      await write((context) =>
        context.auth.signInWithPassword({ email, password: initialPassword }),
      )
    ).error != null,
  );
  assert.equal(
    (await write((context) => context.auth.signInWithPassword({ email, password: nextPassword })))
      .error,
    null,
  );
  assert.equal((await write((context) => context.auth.sendMagicLink(email))).error, null);
  const magic = await emailLink(email, "https://app.example.com/signed-in");
  assert.equal(magic.get("type"), "magiclink");
  assert.equal(
    (
      await write((context) =>
        context.auth.verifyEmailLink({
          type: "magiclink",
          token: fixtureString(magic.get("token")),
        }),
      )
    ).data?.id,
    id,
  );
  assert(
    (
      await write((context) =>
        context.auth.verifyEmailLink({
          type: "magiclink",
          token: fixtureString(magic.get("token")),
        }),
      )
    ).error != null,
  );
  assert.equal((await write((context) => context.auth.signOut())).error, null);
  assert.equal(
    (await integration.read(jar, (context) => context.getUser())).error?.code,
    "session_missing",
  );
  assert.equal(poolFailure, false);
  console.log(
    JSON.stringify(
      {
        backend: "real disposable Nelcota and PostgreSQL",
        email: "real STARTTLS delivery to disposable Mailpit",
        checks: [
          "signup",
          "verified user across independent stores",
          "metadata update",
          "eight concurrent refreshes and real token rotation",
          "recovery link, replay rejection and password replacement",
          "password login",
          "magic link and replay rejection",
          "logout and cookie removal",
        ],
        oauth:
          "the separately selected nextjs_sdk_finishes_a_real_pkce_flow contract runs the Next SDK against real Nelcota and local provider endpoints",
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
