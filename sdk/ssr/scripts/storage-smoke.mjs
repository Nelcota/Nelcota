import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
// N02 against a real S3-compatible provider and a real Nelcota server. Never production.
// Run: node --conditions=react-server scripts/storage-smoke.mjs, with a disposable
// loopback PostgreSQL, a loopback S3 endpoint and a server binary (see README).

import { Pool } from "pg";

import { fixtureErrorCode, fixtureString } from "./fixture-values.mjs";
import { Jar, fixtureDirectory, reservePort } from "./server-fixture-smoke.mjs";
import { FixtureProvider } from "./storage-provider-smoke.mjs";
const requestTimeoutInMs = 1000;
const delayInMs = 100;
const forceStopInMs = 3000;

let Integration, DevelopmentSessionStore;
try {
  ({ Integration } = await import("../dist/context.js"));
  ({ DevelopmentSessionStore } = await import("../dist/memory-store.js"));
} catch (error) {
  if (/Client Component/.test(String(error instanceof Error ? error.message : error)))
    throw new Error("Run with: node --conditions=react-server scripts/storage-smoke.mjs");
  throw error;
}
/** @param {string} name */
const env = (name) => {
  const value = process.env[name];
  if (value == null || value === "") throw new Error(`Set ${name}`);
  return value;
};
const binary = env("NELCOTA_NEXT_TEST_BINARY"),
  connectionString = env("NELCOTA_NEXT_TEST_DATABASE_URL");
const s3 = {
  endpoint: new URL(env("NELCOTA_NEXT_TEST_S3_ENDPOINT")),
  key: env("NELCOTA_NEXT_TEST_S3_ACCESS_KEY_ID"),
  secret: env("NELCOTA_NEXT_TEST_S3_SECRET_ACCESS_KEY"),
  region: "us-east-1",
};
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const database = new URL(connectionString);
if (loopback.has(database.hostname) === false || loopback.has(s3.endpoint.hostname) === false)
  throw new Error("Only loopback disposable database and S3 endpoints are allowed");

const provider = new FixtureProvider(s3);

const name = `nelcota_next_test_${randomBytes(8).toString("hex")}`,
  bucket = `nelcota-next-${randomBytes(6).toString("hex")}`;
const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
database.pathname = `/${name}`;
const pool = new Pool({ connectionString: database.href, max: 2, connectionTimeoutMillis: 2000 });
const directory = await fixtureDirectory("nelcota-next-storage-");
/** @type {import("node:child_process").ChildProcessByStdio<null, null, import("node:stream").Readable> | undefined} */
let server;
let created = false,
  bucketCreated = false,
  report;
let cleaning = false;
/** @type {string[]} */
const unexpectedPoolErrors = [];
for (const connectionPool of [admin, pool])
  connectionPool.on("error", (error) => {
    if (cleaning && fixtureErrorCode(error) === "57P01") return; // DROP DATABASE FORCE ending an idle socket
    unexpectedPoolErrors.push(fixtureErrorCode(error) ?? "pool_error");
    process.exitCode = 1;
  });
const port = await reservePort();
const apiOrigin = `http://127.0.0.1:${port}`,
  origin = "http://localhost:3000";
const request = () => new Request(origin + "/files", { method: "POST", headers: { origin } });
/** Every request the adapter sends, with its headers and response status/location. */
/** @typedef {{url: URL, headers: Headers, redirect: RequestRedirect | undefined, status?: number, location?: string | null}} Hop */
/** @type {Hop[]} */
const hops = [];
/** @type {import("../../typescript/dist/index.js").FetchLike} */
const recording = async (input, init = {}) => {
  /** @type {Hop} */
  const entry = {
    url: new URL(input instanceof Request ? input.url : input),
    headers: new Headers(init.headers),
    redirect: init.redirect,
  };
  hops.push(entry);
  const response = await fetch(input, init);
  entry.status = response.status;
  entry.location = response.headers.get("location");
  return response;
};
try {
  const sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  await provider.request("PUT", `/${bucket}`);
  bucketCreated = true;
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
      // Load from one process; Rust tests cover the API budget.
      NELCOTA_API_RATE_LIMIT_PER_MINUTE: "0",
      RUST_LOG: "error",
      NELCOTA_STORAGE_BACKEND: "s3",
      NELCOTA_STORAGE_S3_ENDPOINT: s3.endpoint.origin,
      NELCOTA_STORAGE_S3_BUCKET: bucket,
      NELCOTA_STORAGE_S3_REGION: s3.region,
      NELCOTA_STORAGE_S3_ACCESS_KEY_ID: s3.key,
      NELCOTA_STORAGE_S3_SECRET_ACCESS_KEY: s3.secret,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = "";
  server.stderr.on("data", (chunk) => {
    if (diagnostics.length < 4000) diagnostics += chunk;
  });
  await waitForBackend(apiOrigin, server, () => diagnostics);

  await pool.query(`INSERT INTO storage.buckets (id, public) VALUES ('files', false);
    CREATE POLICY own_files ON storage.objects FOR ALL TO authenticated USING (bucket_id = 'files' AND owner = auth.uid()) WITH CHECK (bucket_id = 'files' AND owner = auth.uid());`);
  const keys = [randomBytes(32).toString("base64url")],
    store = new DevelopmentSessionStore();
  const base = {
    url: apiOrigin,
    appOrigin: origin,
    keys,
    store,
    allowInsecureDevelopment: true,
    fetch: recording,
  };
  const allowed = await Integration.create({
    ...base,
    storageRedirectOrigins: [s3.endpoint.origin],
  });
  const unset = await Integration.create(base);
  const elsewhere = await Integration.create({
    ...base,
    storageRedirectOrigins: ["http://127.0.0.1:9"],
  });
  const jar = new Jar();
  const signedUp = await allowed.write(jar, request(), (context) =>
    context.auth.signUp({
      email: "files@example.test",
      password: randomBytes(24).toString("base64url"),
    }),
  );
  assert.equal(signedUp.error, null);
  assert.equal(signedUp.data.confirmationRequired, false);
  const path = `${signedUp.data.user.id}/hello.txt`,
    content = `hello from nelcota-next ${randomBytes(8).toString("hex")}`;
  const uploaded = await allowed.write(jar, request(), (context) =>
    context.client.storage
      .from("files")
      .upload(path, new Blob([content], { type: "text/plain" }), { contentType: "text/plain" }),
  );
  assert.equal(uploaded.error, null, JSON.stringify(uploaded.error));

  const toProvider = () => hops.filter((hop) => hop.url.origin === s3.endpoint.origin);
  // Allowed: the API answers 302 to a presigned provider URL; the adapter follows without credentials.
  hops.length = 0;
  const downloaded = await allowed.read(jar, (context) =>
    context.client.storage.from("files").download(path),
  );
  assert.equal(downloaded.error, null, JSON.stringify(downloaded.error));
  assert.equal(await downloaded.data.text(), content);
  const [first, second, ...rest] = hops;
  assert.equal(rest.length, 0);
  assert(first != null && second != null, "Missing download redirect hops");
  assert.equal(first.url.origin, apiOrigin);
  assert.equal(first.redirect, "manual");
  assert.equal(first.status, 302);
  assert.match(
    first.headers.get("authorization") ?? "",
    /^Bearer /,
    "the API hop carries the user token",
  );
  const presigned = new URL(fixtureString(first.location));
  assert.equal(presigned.origin, s3.endpoint.origin);
  assert(presigned.searchParams.has("X-Amz-Signature"));
  assert.equal(second.url.href, presigned.href);
  assert.equal(second.status, 200);
  for (const header of second.headers.keys())
    assert(
      [
        "accept",
        "range",
        "if-none-match",
        "if-match",
        "if-modified-since",
        "if-unmodified-since",
        "if-range",
      ].includes(header),
      `credential-capable header ${header} reached the provider`,
    );
  assert(
    presigned.href.includes(fixtureString(first.headers.get("authorization")).slice(7)) === false,
    "user token in presigned URL",
  );
  assert(presigned.href.includes(s3.secret) === false, "provider secret in presigned URL");
  // A range survives the hop and is served by the provider.
  const ranged = await allowed.read(jar, async (context) => {
    const opened = await context.client.storage
      .from("files")
      .open(path, { range: { start: 0, end: 4 } });
    assert.equal(opened.error, null);
    return { status: opened.data.status, body: await opened.data.text() };
  });
  assert.deepEqual(ranged, { status: 206, body: "hello" });
  assert.equal(toProvider().at(-1)?.headers.get("range"), "bytes=0-4");

  // Fail closed: no policy, or a policy for another origin, never contacts the provider.
  for (const [
    label,
    integration,
  ] of /** @type {[string, import("../dist/context.js").Integration<unknown>][]} */ ([
    ["unset", unset],
    ["other origin", elsewhere],
  ])) {
    hops.length = 0;
    // oxlint-disable-next-line no-await-in-loop -- Keep provider mutations and cleanup ordered; a later step depends on the preceding result.
    const refused = await integration.read(jar, (context) =>
      context.client.storage.from("files").download(path),
    );
    assert.equal(refused.data, null, label);
    assert.equal(refused.error.code, "storage_redirect_refused", label);
    assert.equal(hops.length, 1, label);
    assert.equal(hops[0]?.status, 302, label);
    assert.equal(toProvider().length, 0, label);
  }
  report = {
    binary,
    sha256,
    provider: "loopback S3-compatible endpoint (HTTP, path-style)",
    checks: [
      "real signup and S3-backed upload through write()",
      "API download answers 302 to a presigned provider URL",
      "allow-listed redirect followed; bytes match",
      "provider hop carries no Authorization/cookie/apikey (only allow-listed headers)",
      "no user token or provider secret in the presigned URL",
      "range request served by provider (206)",
      "no policy: storage_redirect_refused, provider never contacted",
      "other-origin policy: storage_redirect_refused, provider never contacted",
    ],
    database: "disposable; removed in finally",
    providerBucket: "disposable; emptied and removed in finally",
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
  if (bucketCreated) await removeProviderBucket();
  /** @returns {Promise<void>} */
  async function removeProviderBucket() {
    const listing = await provider.request("GET", `/${bucket}`, "list-type=2");
    for (const [, key] of listing.matchAll(/<Key>([^<]+)<\/Key>/g))
      // oxlint-disable-next-line no-await-in-loop -- Keep provider mutations and cleanup ordered; a later step depends on the preceding result.
      await provider.request(
        "DELETE",
        `/${bucket}/${fixtureString(key).split("/").map(encodeURIComponent).join("/")}`,
      );
    await provider.request("DELETE", `/${bucket}`);
  }
}
assert.deepEqual(unexpectedPoolErrors, [], "Unexpected pool background failure");
console.log(JSON.stringify(report, null, 2));

/** @param {string} origin
 * @param {import("node:child_process").ChildProcess} child
 * @param {() => string} diagnostics
 * @returns {Promise<void>} */
async function waitForBackend(origin, child, diagnostics) {
  for (let attempt = 0; ; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Keep provider mutations and cleanup ordered; a later step depends on the preceding result.
    const response = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(requestTimeoutInMs),
    }).catch(() => null);
    if (response?.ok === true) return;
    if (attempt > 100 || child.exitCode !== null)
      throw new Error("Disposable backend failed to start: " + diagnostics());
    // oxlint-disable-next-line no-await-in-loop -- Keep provider mutations and cleanup ordered; a later step depends on the preceding result.
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
  }
}
