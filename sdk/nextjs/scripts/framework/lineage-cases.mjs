import assert from "node:assert/strict";

import { fixtureString } from "../fixture-values.mjs";
import { reorderLogins, sessionCookie } from "./lineage.mjs";
import { signIn, shown } from "./observations.mjs";
/** @typedef {import("./lineage.mjs").Completion} Completion */
/** @typedef {{tabs: () => Promise<{shared: import("playwright-core").BrowserContext, one: import("playwright-core").Page, two: import("playwright-core").Page}>, race: (actors: Awaited<ReturnType<LineageFixture["tabs"]>>, deliver: import("./lineage.mjs").Ordering["deliver"]) => Promise<{older: string, newer: string, completions: import("./lineage.mjs").Completion[]}>, byEmail: (completions: import("./lineage.mjs").Completion[], email: string) => import("./lineage.mjs").Completion, runningBrowser: import("playwright-core").Browser, origin: string}} LineageFixture */
/** @param {{runningBrowser: import("playwright-core").Browser, origin: string, grants: string[], destinations: string[]}} options */
function lineageActors({ runningBrowser, origin, grants, destinations }) {
  // N01 in a real browser: two tabs (one cookie jar) that loaded /login sign in concurrently.
  const tabs = async () => {
    const shared = await runningBrowser.newContext();
    const one = await shared.newPage(),
      two = await shared.newPage();
    await one.goto(origin + "/login");
    await two.goto(origin + "/login");
    const ids = sessionCookie(await shared.cookies());
    assert.equal(ids.length, 1, "tabs share one bootstrap ID");
    return { shared, one, two };
  };
  /** @param {Awaited<ReturnType<typeof tabs>>} actors
   * @param {Parameters<typeof reorderLogins>[2]["deliver"]} deliver */
  const race = async ({ shared, one, two }, deliver) => {
    const start = grants.length;
    const replay = await reorderLogins(shared, 2, { deliver, destinations, grants });
    const statuses = Promise.all([
      signIn(one, "alice@example.test"),
      signIn(two, "bob@example.test"),
    ]);
    const completions = await replay();
    const received = await statuses;
    assert(
      received.every((status) => status === 200 || status === "lost"),
      `concurrent login failed: ${received.join(", ")}`,
    );
    const [older, newer] = grants.slice(start);
    assert(older !== undefined && newer !== undefined && older !== newer);
    return { older, newer, completions };
  };
  /** @param {Completion[]} completions
   * @param {string} email */
  const byEmail = (completions, email) => {
    const entry = completions.find((entry) => entry.body.toString().includes(email));
    assert(entry != null, "Missing concurrent login completion");
    return entry;
  };

  return { tabs, race, byEmail };
}
/** @param {LineageFixture} fixture */
async function reversedDelivery({ tabs, race, origin }) {
  // Responses reach the browser in reverse order: the older sign-in's cookie lands last.
  const tab = await tabs();
  const { older, newer } = await race(tab, (completions) => ({
    order: completions.toReversed(),
  }));
  const seen = await shown(tab.one, origin);
  assert.notEqual(seen, older, "stale identity won silently");
  assert.equal(seen, null);
  assert.equal(await shown(tab.two, origin), null);
  await tab.one.goto(origin + "/account");
  assert.equal(new URL(tab.one.url()).pathname, "/login");
  const result = { older, newer, browserShows: "signed out (superseded)" };
  await tab.shared.close();
  return result;
}
/** @param {LineageFixture} fixture */
async function naturalDelivery({ tabs, race, origin }) {
  // Natural order: the newer sign-in's cookie lands last and is the live identity.
  const tab = await tabs();
  const { older, newer } = await race(tab, (completions) => ({ order: completions }));
  assert.equal(await shown(tab.one, origin), newer);
  assert.equal(await shown(tab.two, origin), newer);
  const result = { older, newer, browserShows: newer };
  await tab.shared.close();
  return result;
}
/** @param {LineageFixture} fixture */
async function lostWinningResponse({ tabs, race, origin, byEmail }) {
  // Lost winning response: the newer response never reaches the browser.
  const tab = await tabs();
  const { older, newer, completions } = await race(tab, (completions) => ({
    order: completions.slice(0, 1),
    lost: completions.slice(1),
  }));
  assert.equal(await shown(tab.one, origin), null, "stale identity won after a lost response");
  // Documented residual: the lost winner's row stays live until a later sign-in/out of the lineage.
  const lostCookie = fixtureString(
    fixtureString(byEmail(completions, newer).cookies[0]).split(";")[0],
  );
  const lostView = async () =>
    (await (await fetch(origin + "/profile", { headers: { cookie: lostCookie } })).text()).includes(
      newer,
    );
  assert.equal(await lostView(), true);
  assert.equal(await signIn(tab.one, older), 200);
  assert.equal(await shown(tab.one, origin), older);
  assert.equal(await lostView(), false, "a later lineage sign-in retires the lost winner");
  const result = {
    older,
    newer,
    browserShows: "signed out (superseded)",
    lostRowLiveUntilNextLineageSignIn: true,
  };
  await tab.shared.close();
  return result;
}
/** @param {LineageFixture} fixture */
async function cookielessResidualCase({ runningBrowser, race, origin }) {
  // Documented residual, pinned: without a bootstrap ID (cookie-less tabs that skipped
  // /login) the two sign-ins are unrelated sessions and the last delivered one stays.
  const shared = await runningBrowser.newContext();
  const one = await shared.newPage(),
    two = await shared.newPage();
  await one.goto(origin + "/");
  await two.goto(origin + "/");
  assert.equal(sessionCookie(await shared.cookies()).length, 0);
  const { older } = await race({ shared, one, two }, (completions) => ({
    order: completions.toReversed(),
  }));
  const result = {
    browserShows: await shown(one, origin),
    olderIdentity: older,
    note: "documented residual: no lineage without a cookie",
  };
  await shared.close();
  return result;
}
/** Exercises cross-process lineage with reversed, natural, lost and cookieless responses.
 * @param {import("playwright-core").Browser} runningBrowser
 * @param {string} origin
 * @param {{grants: string[], destinations: string[]}} state */
export async function verifyLineage(runningBrowser, origin, state) {
  const fixture = {
    runningBrowser,
    origin,
    ...lineageActors({ runningBrowser, origin, ...state }),
  };
  const reversed = await reversedDelivery(fixture);
  const natural = await naturalDelivery(fixture);
  const lostResponse = await lostWinningResponse(fixture);
  const cookielessResidual = await cookielessResidualCase(fixture);
  return { reversed, natural, lostResponse, cookielessResidual };
}
