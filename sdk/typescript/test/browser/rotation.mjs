import assert from "node:assert/strict";
/** @typedef {Awaited<ReturnType<import("../../src/index.js").NelcotaClient["auth"]["getSession"]>>} SessionResult */
/** @typedef {{count: () => number, requests: {page: string, token: unknown}[]}} Rotations */
/** @param {SessionResult[]} sessions */
function matching(sessions) {
  return sessions[0]?.data?.refresh_token === sessions[1]?.data?.refresh_token;
}
/** @param {SessionResult[]} sessions @param {number} count */
function shared(sessions, count) {
  return (
    sessions.every((value) => value.error === null && value.data !== null) &&
    matching(sessions) &&
    count === 1
  );
}
/** @param {number} round @param {SessionResult[]} sessions @param {{rotations: Rotations, before: number}} observation */
function diagnostics(round, sessions, { rotations, before }) {
  console.log("FAIL refresh across two real tabs");
  console.log("Rotation diagnostics:", {
    round: round + 1,
    refreshRequests: rotations.count() - before,
    errors: sessions.map((value) => value.error?.code ?? null),
    present: sessions.map((value) => value.data !== null),
    matching: matching(sessions),
    sameInputToken: rotations.requests
      .slice(before)
      .every((request) => request.token === rotations.requests[before]?.token),
    owners: rotations.requests.slice(before).map((request) => request.page),
  });
}
/** @param {import("playwright-core").Page[]} pages @param {SessionResult[]} sessions */
async function expire(pages, sessions) {
  const session = sessions[0]?.data;
  assert(session != null);
  const expiring = { ...session, expires_at: Math.floor(Date.now() / 1000) + 5 };
  await Promise.all(
    pages.map((page) =>
      page.evaluate(async (serialized) => {
        const { parseSession } = await import("/dist/auth/session.js");
        const session = parseSession(serialized);
        if (session === null) throw new Error("Invalid transferred browser session");
        return await globalThis.sdkClient.auth.setSession(session);
      }, JSON.stringify(expiring)),
    ),
  );
}
/** Exercises native cross-tab contention without printing session tokens.
 * @param {import("playwright-core").Page[]} pages @param {Rotations} rotations @param {number} rounds */
export async function verifySharedRefresh(pages, rotations, rounds) {
  for (let round = 0; round < rounds; round++) {
    const before = rotations.count();
    // oxlint-disable-next-line no-await-in-loop -- Each contention depends on the session published by the preceding round.
    const sessions = await Promise.all(
      pages.map((page) => page.evaluate(() => globalThis.sdkClient.auth.getSession())),
    );
    if (shared(sessions, rotations.count() - before) === false) {
      diagnostics(round, sessions, { rotations, before });
      return false;
    }
    if (round === rounds - 1) {
      console.log(`ok  refresh across two real tabs (${rounds} rounds)`);
      return true;
    }
    // Keep both clients warm and expiring for the next contention.
    // oxlint-disable-next-line no-await-in-loop -- Transfer the accepted session before the next contention.
    await expire(pages, sessions);
  }
  return true;
}
