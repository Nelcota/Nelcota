import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
// Real Next/browser transport smoke. The local API is a fixture, NOT RLS evidence.
import { join } from "node:path";

import { Pool } from "pg";

import { verifyClientBundles } from "./client-bundle-check.mjs";
import { buildExample, example, linkPackage, nextVersion } from "./example.mjs";
import { fixtureObject, fixtureString } from "./fixture-values.mjs";
import {
  verifyAuthFlows,
  FrameworkAuth,
  FrameworkProcesses,
  verifyLineage,
  sessionCookie,
  launchFixtureBrowser,
} from "./framework/index.mjs";

/** @type {import("playwright-core").Browser | undefined} */
let browser;
/** @type {Pool | undefined} */
let admin;
let databaseCreated = false;
const databaseName = `nelcota_next_test_${randomBytes(8).toString("hex")}`;
const auth = new FrameworkAuth();
const { user, counts, grants } = auth;

const processes = new FrameworkProcesses(auth);

try {
  const connectionString = process.env.NELCOTA_NEXT_TEST_DATABASE_URL;
  if (connectionString == null || connectionString === "")
    throw new Error(
      "Set NELCOTA_NEXT_TEST_DATABASE_URL to the disposable shared PostgreSQL fixture",
    );
  const database = new URL(connectionString);
  if (["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) === false)
    throw new Error("Only a loopback disposable database is allowed");
  admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
  admin.on("error", () => {
    process.exitCode = 1;
  });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  database.pathname = `/${databaseName}`;
  const installer = new Pool({
    connectionString: database.href,
    max: 1,
    connectionTimeoutMillis: 2000,
  });
  try {
    await installer.query(
      await readFile(new URL("../../ssr/sql/session-store.sql", import.meta.url), "utf8"),
    );
  } finally {
    await installer.end();
  }
  await linkPackage();
  const buildKey = randomBytes(32).toString("base64url");
  const build = buildExample({ NELCOTA_SESSION_KEY: buildKey });
  processes.output.write(build.stdout + build.stderr);
  assert.equal(build.status, 0, "example production build failed; see private log");
  const clientChunks = await verifyClientBundles(join(example, ".next/static"), buildKey);
  const { origin, destinations } = await processes.start(database, buildKey);
  const denied = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { origin: "https://foreign.test", "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "fixture-password" }),
  });
  assert.equal(denied.status, 500);
  assert.equal(counts.password, 0);
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "fixture-password" }),
  });
  assert.equal(login.status, 200);
  const payload = await login.text();
  assert(payload.includes("-private") === false);
  const cookie = login.headers.get("set-cookie");
  assert(cookie != null && cookie !== "");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=lax/i);
  assert.match(fixtureString(login.headers.get("cache-control")), /private.*no-store/);
  const profilePage = await fetch(origin + "/profile", {
    headers: { cookie: fixtureString(cookie.split(";")[0]) },
  });
  assert.equal(profilePage.status, 200);
  assert((await profilePage.text()).includes(user.email));
  // Proxy: signed-out visitors are routed to login; a signed-in one reaches the page.
  const guarded = await fetch(origin + "/account", { redirect: "manual" });
  assert.equal(guarded.status, 303);
  assert.equal(new URL(fixtureString(guarded.headers.get("location")), origin).pathname, "/login");
  assert.match(fixtureString(guarded.headers.get("cache-control")), /private.*no-store/);
  const account = await fetch(origin + "/account", {
    headers: { cookie: fixtureString(cookie.split(";")[0]) },
    redirect: "manual",
  });
  assert.equal(account.status, 200);
  assert((await account.text()).includes(user.email));

  const { browser: runningBrowser, engine } = await launchFixtureBrowser();
  browser = runningBrowser;
  const context = await runningBrowser.newContext();
  const page = await context.newPage();
  await page.goto(origin + "/login");
  const bootstrap = sessionCookie(await context.cookies());
  assert.equal(bootstrap.length, 1, "login page issued a bootstrap ID");
  const bootstrapId = fixtureString(fixtureObject(bootstrap[0]).value);
  assert.equal(bootstrapId.length, 43);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(origin + "/profile");
  assert.equal(await page.getByTestId("email").textContent(), user.email);
  const cookies = sessionCookie(await context.cookies());
  assert.equal(cookies.length, 1);
  const sessionId = fixtureString(fixtureObject(cookies[0]).value);
  assert.equal(sessionId.length, 43);
  assert.notEqual(sessionId, bootstrapId, "sign-in moved to a fresh ID");
  const source = await page.content();
  assert(Boolean(source.includes("-private")) === false);
  const loggedOut = await page.evaluate(
    async () => (await fetch("/api/logout", { method: "POST" })).status,
  );
  assert.equal(loggedOut, 200);
  await page.reload();
  await page.getByRole("heading", { name: "Signed out" }).waitFor();
  await context.close();

  const { flows, cookieBytes, repeatedReadMs } = await verifyAuthFlows(
    runningBrowser,
    origin,
    auth,
  );
  const locks = await admin.query(
    "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=$1)",
    [databaseName],
  );
  assert.equal(
    fixtureObject(locks.rows[0]).count,
    "0",
    "completed requests released every session advisory lock",
  );
  await flows.close();

  const multiTab = await verifyLineage(runningBrowser, origin, { grants, destinations });
  console.log(
    JSON.stringify(
      {
        framework: `Next ${nextVersion} production webpack / React 19.3.1`,
        runtime:
          Object.hasOwn(process.versions, "bun") === false
            ? `node ${process.version}`
            : `bun ${process.versions.bun}`,
        browser: `${engine} ${browser.version()}`,
        processes: processes.children.length,
        sessionStore: "shared disposable PostgreSQL",
        authFlows: [
          "password Server Action",
          "signup awaiting confirmation",
          "resend",
          "confirmation and replay",
          "update user",
          "refresh after 401",
          "recovery and replay",
          "magic link and replay",
          "OAuth S256 PKCE callback, browser binding and replay",
          "logout",
        ],
        resources: {
          clientChunks,
          cookieBytes,
          repeatedReads: 100,
          repeatedReadMs: Math.round(repeatedReadMs),
          retainedAdvisoryLocks: 0,
        },
        checks: [
          "cross-origin request refused before API",
          "Route Handler HttpOnly cookie merged",
          "private response cache",
          "Server Component verified user",
          "proxy routes signed-out visitor to login",
          "proxy bootstrap ID on login page",
          "Server Action redirect retains cookie",
          "HTML contains no session credentials",
          "all production client chunks exclude build-time key and server-session/credential canaries",
          "logout clears browser session",
          "N01 two tabs/processes, reversed delivery: signed out, never the older identity",
          "N01 two tabs/processes, natural delivery: newer identity",
          "N01 lost winning response: signed out; lost row retired by next lineage sign-in",
        ],
        multiTab,
        counts,
        authorization: "not tested: local transport fixture",
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await processes.stop();
  if (databaseCreated) {
    assert(admin != null);
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  }
  await admin?.end();
  await processes.closeApi();
}
