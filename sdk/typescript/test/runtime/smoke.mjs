// The built package on a given runtime (Node, Bun, Deno) with its own
// fetch, Web Crypto, AbortSignal and timers, against a small local server.
//
//   node test/runtime/smoke.mjs  |  bun test/runtime/smoke.mjs  |  deno run -A test/runtime/smoke.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createClient } from "../../dist/index.js";
const cancelDelayInMs = 50;

const session = {
  access_token: "access-1",
  token_type: "bearer",
  expires_in: 900,
  expires_at: Math.floor(Date.now() / 1000) + 900,
  refresh_token: "refresh-1",
  user: {
    id: "u1",
    email: "ana@example.com",
    email_confirmed_at: null,
    user_metadata: {},
    created_at: "",
    last_sign_in_at: null,
  },
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://x");
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const delayInMs = 1000;

    /** @param {number} status
     * @param {unknown} value
     * @param {Record<string, string>} [headers] */
    const json = (status, value, headers = {}) =>
      response
        .writeHead(status, { "content-type": "application/json", ...headers })
        .end(JSON.stringify(value));
    if (url.pathname === "/auth/v1/token") return json(200, session);
    if (url.pathname === "/rest/v1/notes") {
      return json(
        200,
        [{ id: 1, auth: request.headers.authorization ?? null, query: url.search }],
        { "content-range": "0-0/1" },
      );
    }
    if (url.pathname === "/storage/v1/object/files/u1/a.txt") {
      return json(201, {
        id: "fixture",
        bucket: "files",
        name: "u1/a.txt",
        size: body.length,
        mime_type: "text/plain",
        etag: "fixture",
      });
    }
    if (url.pathname === "/rest/v1/slow") return setTimeout(() => json(200, []), delayInMs);
    json(404, { code: "not_found", message: "no" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
const address = server.address();
assert(address !== null && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;

/** @type {{name: string, ok: boolean, detail: unknown}[]} */
const checks = [];
/** @param {string} name
 * @param {boolean} ok
 * @param {unknown} [detail] */
const check = (name, ok, detail) => checks.push({ name, ok, detail });

try {
  const nelcota = createClient(base, { timeout: 500, retries: 0 });
  const signIn = await nelcota.auth.signInWithPassword({
    email: "ana@example.com",
    password: "pw",
  });
  check("sign in", signIn.error === null);

  const read = await nelcota.from("notes").select("id").eq("body", "a,b").order("id").execute();
  check("authorized read", read.data?.[0]?.auth === "Bearer access-1", read.data);
  check(
    "query encoding",
    read.data?.[0]?.query === "?select=id&body=eq.a%2Cb&order=id.asc",
    read.data?.[0]?.query,
  );
  check("count", read.count === 1);

  const oauth = await nelcota.auth.signInWithOAuth({
    provider: "github",
    redirectTo: "https://app.example.com/",
  });
  check(
    "pkce via Web Crypto",
    /code_challenge=[A-Za-z0-9_-]{43}&/.test(oauth.data?.url ?? ""),
    oauth.data?.url,
  );

  const upload = await nelcota.storage.from("files").upload("u1/a.txt", "hello");
  check("upload", upload.data?.size === 5, upload);

  const slow = await createClient(base, { timeout: 100, retries: 0 })
    .from("slow")
    .select()
    .execute();
  check("timeout", slow.error?.code === "timeout", slow.error);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), cancelDelayInMs);
  const aborted = await nelcota.from("slow").select().abortSignal(controller.signal).execute();
  check("abort", aborted.error?.code === "aborted", aborted.error);
} catch (error) {
  check("no exception", false, error instanceof Error ? error.stack : String(error));
} finally {
  server.close();
}

/** @returns {string} Runtime identity for the smoke report. */
function runtimeName() {
  if (globalThis.Deno !== undefined) return `deno ${globalThis.Deno.version.deno}`;
  if (typeof globalThis.Bun !== "undefined") return `bun ${Bun.version}`;
  return `node ${process.version}`;
}
const runtime = runtimeName();
let failed = false;
for (const { name, ok, detail } of checks) {
  failed ||= Boolean(ok) === false;
  console.log(
    `${ok ? "ok  " : "FAIL"} [${runtime}] ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`,
  );
}
process.exit(failed ? 1 : 0);
