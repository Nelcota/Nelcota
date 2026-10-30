import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
// Explicit binary compatibility test; records binary identity. Never production.

import { Pool } from "pg";

import {
  leaseBoundaries,
  pendingRecord,
  releasedRecord,
  backendRevocation,
  localLogout,
} from "./backend-sessions-smoke.mjs";
import { runSustainedLoad } from "./backend-soak-smoke.mjs";
import { fixtureErrorCode, fixtureString, fixtureObject } from "./fixture-values.mjs";
import { Jar, backendResources, waitForBackend, waitForCatalog } from "./server-fixture-smoke.mjs";
const forceStopInMs = 3000;

// The package entries import `server-only`, which only loads under Next's server condition.
/** @type {typeof import("../../ssr/dist/context.js").Integration} */
let Integration;
/** @type {typeof import("../../ssr/dist/postgres.js").PostgresSessionStore} */
let PostgresSessionStore;
try {
  ({ Integration } = await import("../../ssr/dist/context.js"));
  ({ PostgresSessionStore } = await import("../../ssr/dist/postgres.js"));
} catch (error) {
  if (/Client Component/.test(String(error instanceof Error ? error.message : error)))
    throw new Error("Run with: node --conditions=react-server scripts/backend-smoke.mjs");
  throw error;
}

const binary = process.env.NELCOTA_NEXT_TEST_BINARY;
const connectionString = process.env.NELCOTA_NEXT_TEST_DATABASE_URL;
if (binary == null || binary === "" || connectionString == null || connectionString === "")
  throw new Error("Explicit disposable database and test binary required");
const database = new URL(connectionString);
if (["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) === false)
  throw new Error("Only a loopback disposable database is allowed");
const name = `nelcota_next_test_${randomBytes(8).toString("hex")}`;
const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
database.pathname = `/${name}`;
const pool = new Pool({ connectionString: database.href, max: 4, connectionTimeoutMillis: 2000 });
/** @type {import("node:child_process").ChildProcessByStdio<null, null, import("node:stream").Readable> | undefined} */
let server;
let created = false,
  cleaning = false,
  report;
/** @type {string[]} */
const unexpectedPoolErrors = [];
for (const connectionPool of [admin, pool])
  connectionPool.on("error", (error) => {
    // DROP DATABASE FORCE can finish terminating an already-closed idle socket.
    if (cleaning && fixtureErrorCode(error) === "57P01") return;
    unexpectedPoolErrors.push(fixtureErrorCode(error) ?? "pool_error");
    process.exitCode = 1; // observe background failure without printing credentials
  });
const { directory, port } = await backendResources();
const origin = "http://localhost:3000";
const request = () => new Request(origin + "/auth/login", { method: "POST", headers: { origin } });

try {
  const sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  server = spawn("nice", ["-n", "10", binary, "serve"], {
    cwd: directory,
    env: {
      ...process.env,
      NELCOTA_DATABASE_URL: database.href,
      NELCOTA_AUTHENTICATOR_PASSWORD: randomBytes(24).toString("base64url"),
      NELCOTA_JWT_SECRET: randomBytes(32).toString("base64url"),
      NELCOTA_LISTEN: `127.0.0.1:${port}`,
      // The soak drives concurrent load from one process; Rust tests cover the limit.
      NELCOTA_API_CONCURRENCY_PER_CALLER: "0",
      NELCOTA_STORAGE_BACKEND: "off",
      RUST_LOG: "error",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  server.stderr.on("data", (chunk) => {
    if (diagnostics.length < 4000) diagnostics += chunk;
  });
  await waitForBackend(`http://127.0.0.1:${port}`, server, () => diagnostics);

  await pool.query(
    await readFile(new URL("../../ssr/sql/session-store.sql", import.meta.url), "utf8"),
  );
  await pool.query(`CREATE TABLE public.next_notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner uuid NOT NULL DEFAULT auth.uid(), body text NOT NULL, "limit" integer NOT NULL DEFAULT 5, "order" integer NOT NULL DEFAULT 2);
    ALTER TABLE public.next_notes ENABLE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.next_notes TO anon, authenticated;
    GRANT USAGE, SELECT ON SEQUENCE public.next_notes_id_seq TO authenticated;
    CREATE POLICY own_notes ON public.next_notes TO authenticated USING (owner=auth.uid()) WITH CHECK (owner=auth.uid());`);
  const keys = [randomBytes(32).toString("base64url")];
  const integration = await Integration.create({
    url: `http://127.0.0.1:${port}`,
    appOrigin: origin,
    keys,
    store: new PostgresSessionStore(pool),
    allowInsecureDevelopment: true,
  });
  const a = new Jar(),
    b = new Jar();
  for (const [jar, email] of /** @type {[Jar, string][]} */ ([
    [a, "alice@example.test"],
    [b, "bob@example.test"],
  ])) {
    // oxlint-disable-next-line no-await-in-loop -- Keep requests within this fixture worker ordered and wait between bounded readiness attempts.
    const result = await integration.write(jar, request(), (context) =>
      context.auth.signUp({ email, password: randomBytes(24).toString("base64url") }),
    );
    assert.equal(result.error, null);
    assert.equal(result.data.confirmationRequired, false);
  }
  await waitForCatalog(integration, a);
  for (const [jar, body] of /** @type {[Jar, string][]} */ ([
    [a, "alice-private"],
    [b, "bob-private"],
  ])) {
    // oxlint-disable-next-line no-await-in-loop -- Keep requests within this fixture worker ordered and wait between bounded readiness attempts.
    const result = await integration.write(jar, request(), (context) =>
      context.client.from("next_notes").insert({ body }).select().execute(),
    );
    assert.equal(result.error, null);
    assert.equal(result.data[0]?.body, body);
  }
  const both = await Promise.all(
    [a, b].map((jar) =>
      integration.read(jar, async (context) => {
        const user = await context.getUser();
        assert.equal(user.error, null);
        const rows = await context.client.from("next_notes").select().execute();
        assert.equal(rows.error, null);
        return { email: user.data.email, bodies: rows.data.map((row) => row.body) };
      }),
    ),
  );
  assert.deepEqual(both, [
    { email: "alice@example.test", bodies: ["alice-private"] },
    { email: "bob@example.test", bodies: ["bob-private"] },
  ]);
  const reserved = await integration.read(a, (context) =>
    context.client.from("next_notes").select().eq("limit", 500).limit(10).execute(),
  );
  assert.equal(reserved.error, null);
  assert.deepEqual(reserved.data, []);
  const ordered = await integration.read(a, (context) =>
    context.client.from("next_notes").select().eq("order", 99).order("id").execute(),
  );
  assert.equal(ordered.error, null);
  assert.deepEqual(ordered.data, []);
  const anonymous = await integration.read(new Jar(), (context) =>
    context.client.from("next_notes").select().execute(),
  );
  assert.equal(anonymous.error, null);
  assert.deepEqual(anonymous.data, []);
  const crossing = await integration.write(a, request(), (context) =>
    context.client
      .from("next_notes")
      .update({ body: "cross-user" })
      .eq("body", "bob-private")
      .select()
      .execute(),
  );
  assert.equal(crossing.error, null);
  assert.deepEqual(crossing.data, []);
  assert.equal(
    fixtureObject((await pool.query("SELECT count(*) FROM public.next_notes")).rows[0]).count,
    "2",
  );
  assert.equal(
    fixtureObject(
      (await pool.query("SELECT count(*) FROM public.next_notes WHERE body='cross-user'")).rows[0],
    ).count,
    "0",
  );
  // Negative cases use the same final backend and persisted identities as the controls.
  const snapshot = await pool.query(
    "SELECT key, sealed, expires_at FROM nelcota_next.sessions ORDER BY key",
  );
  for (const headers of [
    {
      origin: "https://attacker.invalid",
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000",
      "x-forwarded-proto": "http",
    },
    {},
    { origin, "sec-fetch-site": "cross-site" },
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Keep requests within this fixture worker ordered and wait between bounded readiness attempts.
    await assert.rejects(
      integration.write(
        a,
        new Request(origin + "/auth/logout", { method: "POST", headers }),
        (context) => context.auth.signOut(),
      ),
      { code: "csrf" },
    );
  }
  assert.deepEqual(
    (await pool.query("SELECT key, sealed, expires_at FROM nelcota_next.sessions ORDER BY key"))
      .rows,
    snapshot.rows,
  );
  const forged = new Jar();
  for (const [key, value] of a.values)
    forged.values.set(key, value.slice(0, -1) + (value.endsWith("a") ? "b" : "a"));
  const forgedRows = await integration.read(forged, (context) =>
    context.client.from("next_notes").select().execute(),
  );
  assert.equal(forgedRows.error, null);
  assert.deepEqual(forgedRows.data, []);
  const forbiddenInsert = await integration.write(a, request(), async (context) => {
    const bob = await integration.read(b, (other) => other.getUser());
    return await context.client
      .from("next_notes")
      .insert({ owner: fixtureString(bob.data?.id), body: "forged-owner" })
      .select()
      .execute();
  });
  assert(forbiddenInsert.error != null, "RLS must reject forged ownership");
  const forbiddenDelete = await integration.write(a, request(), (context) =>
    context.client.from("next_notes").delete().eq("body", "bob-private").select().execute(),
  );
  assert.equal(forbiddenDelete.error, null);
  assert.deepEqual(forbiddenDelete.data, []);
  assert.equal(
    fixtureObject((await pool.query("SELECT count(*) FROM public.next_notes")).rows[0]).count,
    "2",
  );

  // Opt-in sustained load: two adapters contend for one small pool and shared keys.
  const seconds = Number(process.env.NELCOTA_NEXT_SOAK_SECONDS ?? 0);
  assert(Number.isInteger(seconds) && seconds >= 0 && seconds <= 3600, "Invalid soak duration");
  const fixture = { integration, pool, keys, origin, port, request, a, b };
  const soak =
    seconds !== 0 && Number.isNaN(seconds) === false
      ? await runSustainedLoad({ ...fixture, Integration, PostgresSessionStore }, seconds)
      : undefined;
  await leaseBoundaries(fixture);
  const record = await pendingRecord(fixture);
  const state = await releasedRecord(fixture, record);
  await backendRevocation(fixture, state);
  await localLogout(fixture);
  const stopped = once(server, "close");
  server.kill("SIGTERM");
  const killTimer = setTimeout(() => server?.kill("SIGKILL"), forceStopInMs);
  await stopped;
  clearTimeout(killTimer);
  const unavailable = await integration.read(b, (context) => context.getUser());
  assert.equal(unavailable.data, null);
  assert.equal(unavailable.error.status, 0);
  const offlineLogout = await integration.write(b, request(), (context) => context.auth.signOut());
  assert(offlineLogout.error != null, "Remote logout must expose transport failure");
  assert.equal(b.values.size, 0);
  const afterFailureLocks = await pool.query(
    "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database())",
  );
  assert.equal(fixtureObject(afterFailureLocks.rows[0]).count, "0");
  report = {
    binary,
    sha256,
    soak,
    checks: [
      "two real signups",
      "verified users",
      "two request identities",
      "isolated RLS reads",
      "anonymous canary empty",
      "cross-user update empty",
      "SQL integrity",
      "reserved filters remain predicates",
      "hostile/missing/cross-site Origin rejected without session mutation",
      "forged cookie has no RLS access",
      "forged owner insert rejected",
      "cross-user delete empty",
      "read-only mutation rejected",
      "escaped context rejected",
      "tampered and expired envelopes cannot access RLS data",
      "backend-revoked refresh rejected; stateless access JWT remains valid until expiry",
      "local logout clears cookie and fences replayed browser state",
      "foreign callback path and malformed state rejected",
      "unsafe OAuth return path normalizes to local root",
      "cookie publication failure surfaces after accepted backend update",
      "stopped backend returns transport failure; offline logout clears local cookie",
      "no advisory locks remain after failure paths",
    ],
    database: "disposable; removed in finally",
    provenance: "supplied binary identity recorded; caller must establish its source revision",
  };
} finally {
  cleaning = true;
  if (server?.exitCode === null) {
    const stopped = once(server, "close");
    server.kill("SIGTERM");
    const timer = setTimeout(() => server?.kill("SIGKILL"), forceStopInMs);
    await stopped;
    clearTimeout(timer);
  }
  await pool.end();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}

assert.deepEqual(unexpectedPoolErrors, [], "Unexpected session pool background failure");
console.log(JSON.stringify(report, null, 2));
