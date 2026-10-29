// The built package in a real Chromium, on another origin than the API, so
// CORS is exercised for real: preflights with Prefer, the exposed
// Content-Range, uploads, the session in localStorage, address-bar cleanup
// and the service_role refusal. Run by scripts/contract.ts --browser.
//
//   node test/browser/smoke.mjs <api url> <service_role token>

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "playwright-core";

import { verifySharedRefresh } from "./rotation.mjs";
import { browserServer } from "./server.mjs";

const [api, serviceToken] = process.argv.slice(2);
if (api == null || api === "" || serviceToken == null || serviceToken === "") {
  console.error("usage: smoke.mjs <api url> <service_role token>");
  process.exit(2);
}

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist");
const examples = resolve(dirname(fileURLToPath(import.meta.url)), "../../examples");
const server = browserServer({
  dist,
  examples,
  moduleFile: new URL("./contract.mjs", import.meta.url),
});
await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
const address = server.address();
assert(address !== null && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;

const engine = process.env.NELCOTA_SDK_BROWSER ?? "chromium";
if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit")
  throw new Error(`Unknown browser: ${engine}`);
const browser = await { chromium, firefox, webkit }[engine].launch(
  engine === "chromium" &&
    process.env.PLAYWRIGHT_CHROMIUM !== undefined &&
    process.env.PLAYWRIGHT_CHROMIUM !== ""
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {},
);
console.log(`Browser: ${engine}`);
let failed = false;
try {
  const context = await browser.newContext();
  const tab = await context.newPage();
  /** @type {string[]} */
  const failures = [];
  tab.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  await tab.goto(`${origin}/app#type=magiclink&token=abc123`);
  /** @type {Record<string, unknown>} */
  const result = await tab.evaluate(
    async (options) => {
      const { browserContract } = await import("/browser-contract.mjs");
      return await browserContract(options);
    },
    { api, serviceToken },
  );

  const expected = {
    link: { type: "magiclink", token: "abc123" },
    cleanedUrl: `${origin}/app`,
    signUpError: null,
    stored: [`nelcota.${new URL(api).host}.session`],
    inserted: "from the browser",
    count: 3,
    upload: 9,
    etagReadable: true,
    download: "blob body",
    serviceRole: "refused",
    signOut: "ok",
    storedAfter: [],
  };
  for (const [key, value] of Object.entries(expected)) {
    const ok = JSON.stringify(result[key]) === JSON.stringify(value);
    failed ||= ok === false;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${key}: ${JSON.stringify(result[key])}${ok ? "" : ` (expected ${JSON.stringify(value)})`}`,
    );
  }
  if (failures.length > 0) console.log(`console errors:\n  ${failures.join("\n  ")}`);

  // Two actual pages share localStorage and Web Locks, rather than a mocked
  // lock manager. Rotation must leave both pages with the same live session.
  await tab.evaluate(async (api) => {
    if (Boolean(navigator.locks) === false)
      throw new Error("Cross-tab rotation requires Web Locks");
    const { createClient } = await import("/dist/index.js");
    globalThis.sdkClient = createClient(api, { auth: { autoRefresh: false } });
    const signup = await globalThis.sdkClient.auth.signUp({
      email: `tabs-${crypto.randomUUID()}@example.com`,
      password: "browser-tabs-password",
    });
    if (signup.error != null) throw signup.error;
    const session = (await globalThis.sdkClient.auth.getSession()).data;
    if (session === null) throw new Error("Missing browser fixture session");
    await globalThis.sdkClient.auth.setSession({
      ...session,
      expires_at: Math.floor(Date.now() / 1000) + 5,
    });
  }, api);
  const other = await context.newPage();
  await other.goto(`${origin}/app`);
  await other.evaluate(async (api) => {
    const { createClient } = await import("/dist/index.js");
    globalThis.sdkClient = createClient(api, { auth: { autoRefresh: false } });
  }, api);
  let refreshRequests = 0;
  /** @type {{page: string, token: unknown}[]} */
  const rotationRequests = [];
  for (const page of [tab, other])
    page.on("request", (request) => {
      if (new URL(request.url()).searchParams.get("grant_type") === "refresh_token") {
        refreshRequests++;
        /** @type {unknown} */
        const payload = request.postDataJSON();
        assert(typeof payload === "object" && payload !== null && "refresh_token" in payload);
        rotationRequests.push({
          page: page === tab ? "first" : "second",
          token: payload.refresh_token,
        });
      }
    });
  const shared = await verifySharedRefresh(
    [tab, other],
    { count: () => refreshRequests, requests: rotationRequests },
    100,
  );
  failed ||= shared === false;
  const oauthSession = (await tab.evaluate(() => globalThis.sdkClient.auth.getSession())).data;
  if (oauthSession === null) throw new Error("OAuth fixture needs the native browser session");
  await tab.evaluate(() => globalThis.sdkClient.auth.signOut());
  await other.waitForFunction(
    async () => (await globalThis.sdkClient.auth.getSession()).data === null,
  );
  console.log("ok  sign-out broadcast to the other tab");

  // Exercise native verifier storage in each engine with a controlled HTTP
  // exchange. Provider validation has dedicated server regressions.
  let challenge = "";
  let exchanges = 0;
  /** @type {boolean[]} */
  const matchedChallenges = [];
  /** @param {URL} url */
  const callback = (url) =>
    url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce";
  for (const page of [tab, other])
    // oxlint-disable-next-line no-await-in-loop -- The next contention or PKCE step depends on the session published by this browser step.
    await page.route(callback, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      exchanges++;
      /** @type {unknown} */
      const payload = route.request().postDataJSON();
      const verifier =
        typeof payload === "object" && payload !== null && "code_verifier" in payload
          ? payload.code_verifier
          : undefined;
      const matches =
        typeof verifier === "string" &&
        createHash("sha256").update(verifier).digest("base64url") === challenge;
      matchedChallenges.push(matches);
      await route.fulfill({
        status: matches ? 200 : 400,
        headers: { "access-control-allow-origin": "*" },
        json: matches ? oauthSession : { code: "invalid_grant", message: "PKCE mismatch" },
      });
    });
  /** @returns {Promise<void>} */
  async function verifyCancelledPkce() {
    const cancelled = await tab.evaluate(
      async () =>
        (
          await globalThis.sdkClient.auth.exchangeCode("browser-code", {
            signal: AbortSignal.abort(),
          })
        ).error?.code,
    );
    if (cancelled !== "aborted")
      throw new Error("Cancelled PKCE exchange did not preserve its claim boundary");
  }
  /** @returns {Promise<void>} */
  async function verifyPkceClaims() {
    for (let flow = 0; flow < 2; flow++) {
      // oxlint-disable-next-line no-await-in-loop -- The next contention or PKCE step depends on the session published by this browser step.
      const started = await tab.evaluate(
        (redirectTo) =>
          globalThis.sdkClient.auth.signInWithOAuth({
            provider: "github",
            redirectTo,
            redirect: false,
          }),
        `${origin}/app`,
      );
      if (started.error != null) throw new Error("Native PKCE publication failed");
      challenge = new URL(started.data.url).searchParams.get("code_challenge") ?? "";
      if (flow === 1) {
        // oxlint-disable-next-line no-await-in-loop -- The next contention or PKCE step depends on the session published by this browser step.
        await verifyCancelledPkce();
      }
      // Error subclasses lose custom fields across Playwright serialization.
      // Extract codes in the browser so negative assertions verify the SDK result.
      // oxlint-disable-next-line no-await-in-loop -- The next contention or PKCE step depends on the session published by this browser step.
      const accepted = await other.evaluate(async () => {
        const value = await globalThis.sdkClient.auth.exchangeCode("browser-code");
        return { code: value.error?.code ?? null, present: Boolean(value.data) };
      });
      // oxlint-disable-next-line no-await-in-loop -- The next contention or PKCE step depends on the session published by this browser step.
      const repeated = await tab.evaluate(
        async () => (await globalThis.sdkClient.auth.exchangeCode("browser-code")).error?.code,
      );
      if (
        Boolean(accepted.code) ||
        accepted.present === false ||
        repeated !== "pkce_missing" ||
        exchanges !== flow + 1
      ) {
        console.log("PKCE diagnostics:", {
          flow,
          exchanges,
          accepted: accepted.code,
          present: accepted.present,
          repeated,
          matchedChallenges,
        });
        throw new Error("Native PKCE handoff or one-time consumption failed");
      }
    }
  }
  await verifyPkceClaims();
  // oxlint-disable-next-line no-await-in-loop -- The next contention or PKCE step depends on the session published by this browser step.
  for (const page of [tab, other]) await page.unroute(callback);
  console.log(
    "ok  native PKCE across real tabs: matching challenge, one-time consumption and pre-cancelled exchange",
  );
  await Promise.all(
    [tab, other].map((page) => page.evaluate(() => globalThis.sdkClient.dispose())),
  );

  await other.goto(`${origin}/demo`);
  await other.getByLabel("API URL").fill(api);
  await other.getByLabel("Email", { exact: true }).fill(`demo-${Date.now()}-${engine}@example.com`);
  await other.getByLabel("Password", { exact: true }).fill("browser-demo-password");
  await other.getByRole("button", { name: "Create account", exact: true }).click();
  await other.waitForFunction(() =>
    document.querySelector("#result")?.textContent.includes("Account created"),
  );
  await other.getByLabel("Note", { exact: true }).fill("Hello from the browser demo");
  await other.getByRole("button", { name: "Save note", exact: true }).click();
  await other.waitForFunction(() =>
    document.querySelector("#result")?.textContent.includes("Hello from the browser demo"),
  );
  await other.getByLabel("File", { exact: true }).setInputFiles({
    name: "demo.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("demo contents"),
  });
  await other.getByRole("button", { name: "Upload file", exact: true }).click();
  await other.waitForFunction(() =>
    document.querySelector("#result")?.textContent.includes("demo.txt"),
  );
  await other.getByRole("button", { name: "List notes", exact: true }).click();
  await other.waitForFunction(() =>
    document.querySelector("#result")?.textContent.includes("Hello from the browser demo"),
  );
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await other.waitForFunction(
    () => document.querySelector("#result")?.textContent === "You are signed out.",
  );
  console.log("ok  runnable browser demo: signup, notes, upload and logout");
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
