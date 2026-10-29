import assert from "node:assert/strict";

import { fixtureObject, fixtureString } from "../fixture-values.mjs";
import { sessionCookie } from "./lineage.mjs";
import { shown } from "./observations.mjs";
/** @typedef {import("playwright-core").BrowserContext} BrowserContext */
/** @typedef {import("./auth.mjs").FrameworkAuth} FrameworkAuth */
/** @param {import("playwright-core").Page} page */
function authInvoker(page) {
  /** @param {string} operation
   * @param {Record<string, unknown>} [input] */
  return async (operation, input = {}) => {
    const result = await page.evaluate(
      async ({ operation, input }) => {
        const response = await fetch("/api/auth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation, ...input }),
        });
        return {
          status: response.status,
          cache: response.headers.get("cache-control"),
          body: await response.text(),
        };
      },
      { operation, input },
    );
    assert.match(fixtureString(result.cache), /private.*no-store/);
    assert(
      Boolean(result.body.includes("-private")) === false,
      "auth response exposed credentials",
    );
    const payload = fixtureObject(JSON.parse(result.body));
    return { status: result.status, data: fixtureObject(payload.data ?? {}) };
  };
}
/** @typedef {{flowPage: import("playwright-core").Page, flows: BrowserContext, invoke: ReturnType<typeof authInvoker>, origin: string, auth: FrameworkAuth, password: string, flowEmail: string, linkFor: (type: string) => string}} Flow */
/** Runs the production Route Handler and callback against local auth transport.
 * @param {import("playwright-core").Browser} browser
 * @param {string} origin
 * @param {FrameworkAuth} auth */
export async function verifyAuthFlows(browser, origin, auth) {
  const flows = await browser.newContext(),
    flowPage = await flows.newPage();
  await flowPage.goto(origin + "/login");
  const invoke = authInvoker(flowPage),
    flowEmail = "flow@example.test",
    password = auth.password;
  /** @param {string} type */
  const linkFor = (type) =>
    fixtureString(
      [...auth.emailLinks].findLast(
        ([, link]) => link.row.user.email === flowEmail && link.type === type,
      )?.[0],
    );

  const fixture = { flows, flowPage, invoke, flowEmail, password, origin, auth, linkFor };
  await confirmationFlow(fixture);
  await accountFlow(fixture);
  await oauthCallback(fixture);
  return { flows, ...(await boundedReads(flows, origin)) };
}
/** @param {Flow} fixture */
async function confirmationFlow({ flowPage, invoke, flowEmail, password, origin, linkFor }) {
  const registered = await invoke("signup", { email: flowEmail, password });
  assert.equal(registered.status, 200);
  assert.equal(registered.data.confirmationRequired, true);
  assert.equal(await shown(flowPage, origin), null, "unconfirmed signup is signed out");
  assert.equal((await invoke("resend", { email: flowEmail })).status, 200);
  const confirmation = linkFor("signup");
  assert.equal((await invoke("verify", { type: "magiclink", token: confirmation })).status, 400);
  assert.equal(
    (await invoke("verify", { type: "signup", token: confirmation })).data.email,
    flowEmail,
  );
  assert.equal(
    (await invoke("verify", { type: "signup", token: confirmation })).status,
    400,
    "confirmation cannot replay",
  );
  assert.equal(await shown(flowPage, origin), flowEmail);
}
/** @param {Flow} fixture */
async function accountFlow({ flowPage, invoke, flowEmail, password, linkFor, auth }) {
  const updated = await invoke("update", { displayName: "SDK example" });
  assert.equal(fixtureObject(updated.data.user_metadata).display_name, "SDK example");
  auth.expireSession();
  assert.equal(fixtureObject((await invoke("refresh")).data.user).email, flowEmail);
  assert.equal(auth.counts.refresh, 1);
  assert.equal((await invoke("recover", { email: flowEmail })).status, 200);
  const recovery = linkFor("recovery");
  assert.equal((await invoke("reset", { token: recovery, password })).data.email, flowEmail);
  assert.equal(
    (await invoke("reset", { token: recovery, password })).status,
    400,
    "recovery cannot replay",
  );
  await flowPage.evaluate(() => fetch("/api/logout", { method: "POST" }));
  assert.equal((await invoke("magiclink", { email: flowEmail })).status, 200);
  const magic = linkFor("magiclink");
  assert.equal((await invoke("verify", { type: "magiclink", token: magic })).data.email, flowEmail);
  assert.equal(
    (await invoke("verify", { type: "magiclink", token: magic })).status,
    400,
    "magic link cannot replay",
  );
}
/** @param {Flow} fixture */
async function oauthCallback({ flowPage, flows, invoke, origin, auth }) {
  const oauth = await invoke("oauth", { returnTo: "/profile" });
  assert.equal(oauth.status, 200);
  const provider = new URL(fixtureString(oauth.data.url));
  assert.equal(provider.searchParams.get("code_challenge_method"), "S256");
  const authorized = await fetch(provider, { redirect: "manual" });
  assert.equal(authorized.status, 302);
  const callbackUrl = fixtureString(authorized.headers.get("location"));
  const stolen = await fetch(callbackUrl, { redirect: "manual" });
  assert.equal(stolen.status, 500, "callback without its browser cookie is refused");
  await flowPage.goto(callbackUrl);
  await flowPage.waitForURL(origin + "/profile");
  assert.equal(await flowPage.getByTestId("email").textContent(), auth.user.email);
  const replay = await flows.request.get(callbackUrl, { maxRedirects: 0 });
  assert.equal(replay.status(), 500, "OAuth callback cannot replay");
  assert(Boolean((await flowPage.content()).includes("-private")) === false);
}
/** @param {BrowserContext} flows @param {string} origin */
async function boundedReads(flows, origin) {
  let cookieBytes = 0;
  for (const cookie of sessionCookie(await flows.cookies())) {
    cookieBytes += Buffer.byteLength(`${cookie.name}=${cookie.value}`);
  }
  assert(cookieBytes < 256, "opaque session cookie remains bounded");
  const started = performance.now();
  for (let index = 0; index < 100; index++) {
    // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
    const response = await flows.request.get(origin + "/profile");
    assert.equal(response.status(), 200);
    // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
    assert(Boolean((await response.text()).includes("-private")) === false);
    // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
    await response.dispose();
  }
  const repeatedReadMs = performance.now() - started;
  assert(repeatedReadMs < 30000, "100 session reads exceeded the bounded fixture deadline");

  return { cookieBytes, repeatedReadMs };
}
