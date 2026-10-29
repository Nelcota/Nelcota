import assert from "node:assert/strict";
// Replayed outside the browser: drop transport headers and keep bodies uncompressed.
const hopByHop = new Set([
  "host",
  "connection",
  "content-length",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "accept-encoding",
  "content-encoding",
]);
/** @typedef {{route: import("playwright-core").Route, status: number, body: Buffer, cookies: string[], headers: Record<string, string>}} Completion */
/** @param {import("playwright-core").Cookie[]} cookies */
export const sessionCookie = (cookies) =>
  cookies.filter((row) => row.httpOnly && row.name.startsWith("nelcota-dev-"));
/** @typedef {{route: import("playwright-core").Route, index: number, context: import("playwright-core").BrowserContext, originalCookies: import("playwright-core").Cookie[], destinations: string[]}} Replay */
/** @param {Replay} fixture @returns {Promise<Completion>} */
async function replayLogin({ route, index, context, originalCookies, destinations }) {
  const requestTimeoutInMs = 10000;

  const request = route.request();
  const headers = await replayHeaders(request, context, originalCookies);
  const destination = destinations[index];
  const url =
    destination !== undefined && destination !== ""
      ? new URL(new URL(request.url()).pathname, destination)
      : request.url();
  const response = await fetch(url, {
    method: request.method(),
    headers,
    body:
      request.postDataBuffer() === null ? null : Uint8Array.from(request.postDataBuffer() ?? []),
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutInMs),
  });
  const body = Buffer.from(await response.arrayBuffer());
  return {
    route,
    status: response.status,
    body,
    cookies: response.headers.getSetCookie(),
    headers: Object.fromEntries(
      [...response.headers].filter(
        ([name]) => name !== "set-cookie" && hopByHop.has(name) === false,
      ),
    ),
  };
}
/** @typedef {{deliver: (entries: Completion[]) => {order: Completion[], lost?: Completion[]}, destinations?: string[], grants: string[]}} Ordering */
/** Holds and replays concurrent logins while controlling response delivery order.
 * @param {import("playwright-core").BrowserContext} context
 * @param {number} expected
 * @param {Ordering} ordering */
export async function reorderLogins(context, expected, { deliver, destinations = [], grants }) {
  /** @type {import("playwright-core").Route[]} */
  const held = [];
  const originalCookies = await context.cookies();
  /** @type {PromiseWithResolvers<void>} */
  const arrival = Promise.withResolvers();
  /** @type {PromiseWithResolvers<void>} */
  const completion = Promise.withResolvers();
  const { promise: ready, resolve: release } = arrival;
  const { promise: finished, resolve: finish } = completion;
  await context.route("**/api/login", async (route) => {
    held.push(route);
    if (held.length === expected) release();
    await finished; // the route stays pending until it is fulfilled or aborted below
  });

  return async () => {
    await waitForArrival(ready);
    /** @type {Completion[]} */
    const completions = [];
    await Promise.all(
      held.map(async (route, index) => {
        completions.push(
          await replayLogin({ route, index, context, originalCookies, destinations }),
        );
      }),
    );
    /** @param {Completion} entry */
    const rank = (entry) => grants.findLastIndex((email) => entry.body.toString().includes(email));
    const ordered = completions.toSorted((a, b) => rank(a) - rank(b));
    const plan = deliver(ordered);
    // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
    for (const entry of plan.lost ?? []) await entry.route.abort("connectionreset");
    for (const entry of plan.order)
      // oxlint-disable-next-line no-await-in-loop -- Advance the shared browser/server fixture only after this response or cleanup step settles.
      await entry.route.fulfill({
        status: entry.status,
        body: entry.body,
        headers: {
          ...entry.headers,
          ...(entry.cookies.length !== 0 && Number.isNaN(entry.cookies.length) === false
            ? { "set-cookie": entry.cookies.join("\n") }
            : {}),
        },
      });
    finish();
    await context.unroute("**/api/login");
    return ordered;
  };
}
/** @param {Promise<void>} ready */
async function waitForArrival(ready) {
  let timer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        const delayInMs = 15000;

        timer = setTimeout(
          () => reject(new Error("Concurrent browser requests did not arrive")),
          delayInMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** @param {import("playwright-core").Request} request
 * @param {import("playwright-core").BrowserContext} context
 * @param {import("playwright-core").Cookie[]} originalCookies */
async function replayHeaders(request, context, originalCookies) {
  const headers = Object.fromEntries(
    Object.entries(await request.allHeaders()).filter(
      ([name]) => hopByHop.has(name) === false && name.startsWith(":") === false,
    ),
  );
  // WebKit reports provisional intercepted headers before adding Cookie.
  // These same-origin fetches use credentials=same-origin. Replay the jar
  // for this exact URL; responses remain held, so neither login changed it.
  if (Boolean(headers.cookie) === false && context.browser()?.browserType().name() === "webkit") {
    headers.cookie = (await context.cookies(request.url()))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }
  for (const cookie of sessionCookie(originalCookies))
    assert(
      headers.cookie?.includes(`${cookie.name}=${cookie.value}`) === true,
      "replayed login did not carry the browser bootstrap cookie",
    );

  return headers;
}
