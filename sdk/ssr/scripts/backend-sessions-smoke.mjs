import assert from "node:assert/strict";

import { SessionSealer, sessionKey } from "../dist/sealing/seal.js";
import { fixtureObject, fixtureString } from "./fixture-values.mjs";
import { Jar } from "./server-fixture-smoke.mjs";
/** @typedef {{integration: import("../dist/context.js").Integration<unknown>, pool: import("pg").Pool, keys: string[], origin: string, port: number, request: () => Request, a: Jar, b: Jar}} BackendCase */

/** @param {BackendCase} fixture */
export async function leaseBoundaries({ integration, a, origin }) {
  const blockedWrite = await integration.read(a, (context) =>
    context.client.from("next_notes").insert({ body: "read-only-write" }).select().execute(),
  );
  assert.equal(blockedWrite.error?.code, "read_only");
  const escaped = await integration.read(a, (context) => Promise.resolve(context.getUser));
  await assert.rejects(escaped(), { code: "closed_context" });
  await assert.rejects(
    integration.write(
      a,
      new Request(origin + "/wrong-callback?code=invalid"),
      (context) => context.auth.exchangeCode("invalid"),
      true,
    ),
    { code: "csrf" },
  );
  await assert.rejects(
    integration.write(
      a,
      new Request(origin + "/auth/callback?code=invalid&state=invalid"),
      (context) => context.auth.exchangeCode("invalid"),
      true,
    ),
    { code: "csrf" },
  );
}
/** @param {BackendCase} fixture */
export async function pendingRecord({ integration, a, request, origin, port, pool }) {
  const pending = await integration.write(a, request(), (context) =>
    context.auth.startOAuth({ provider: "github", returnTo: "//attacker.invalid" }),
  );
  assert.equal(pending.error, null);
  assert.equal(
    new URL(fixtureString(new URL(pending.data.url).searchParams.get("redirect_to"))).origin,
    origin,
  );
  const namespace = `${origin}\0${new URL(`http://127.0.0.1:${port}`).href}`;
  const storedKey = await sessionKey(fixtureString([...a.values.values()][0]), namespace);
  const storedRow = fixtureObject(
    (
      await pool.query("SELECT sealed, expires_at FROM nelcota_next.sessions WHERE key=$1", [
        storedKey,
      ])
    ).rows[0],
  );
  const originalRow = {
    sealed: fixtureString(storedRow.sealed),
    expires_at: fixtureString(storedRow.expires_at),
  };

  return { storedKey, originalRow, namespace };
}
/** @param {BackendCase} fixture
 * @param {Awaited<ReturnType<typeof pendingRecord>>} record */
export async function releasedRecord(
  { integration, a, pool, keys },
  { storedKey, originalRow, namespace },
) {
  for (const [label, sealed, expiry] of /** @type {[string, string, string | number][]} */ ([
    ["tampered envelope", originalRow.sealed.slice(0, -4) + "AAAA", originalRow.expires_at],
    ["expired envelope", originalRow.sealed, Date.now() - 1],
  ])) {
    // oxlint-disable-next-line no-await-in-loop -- Keep requests within this fixture worker ordered and wait between bounded readiness attempts.
    await pool.query("UPDATE nelcota_next.sessions SET sealed=$2, expires_at=$3 WHERE key=$1", [
      storedKey,
      sealed,
      expiry,
    ]);
    // oxlint-disable-next-line no-await-in-loop -- Keep requests within this fixture worker ordered and wait between bounded readiness attempts.
    const result = await integration.read(a, (context) =>
      context.client.from("next_notes").select().execute(),
    );
    assert.equal(result.error, null, label);
    assert.deepEqual(result.data, [], label);
  }
  await pool.query("UPDATE nelcota_next.sessions SET sealed=$2, expires_at=$3 WHERE key=$1", [
    storedKey,
    originalRow.sealed,
    originalRow.expires_at,
  ]);
  const sealer = await SessionSealer.create(keys);
  const state = await sealer.open(
    originalRow.sealed,
    `nelcota-next/v1\0${namespace}\0${storedKey}`,
  );
  assert.equal(state.returnTo, "/", "Unsafe return path was retained");

  return state;
}
/** @param {BackendCase} fixture
 * @param {Awaited<ReturnType<typeof releasedRecord>>} state */
export async function backendRevocation({ integration, a, port }, state) {
  const revoked = await fetch(`http://127.0.0.1:${port}/auth/v1/logout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixtureString(fixtureObject(JSON.parse(fixtureString(state.session))).access_token)}`,
    },
  });
  assert(revoked.ok, "Backend logout control failed");
  // Backend logout revokes refresh immediately; access JWTs are stateless until expiry.
  assert.equal(
    (await integration.read(a, (context) => context.getUser())).data?.email,
    "alice@example.test",
  );
  const refresh = await fetch(`http://127.0.0.1:${port}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      refresh_token: fixtureObject(JSON.parse(fixtureString(state.session))).refresh_token,
    }),
  });
  assert.equal(refresh.status, 400);
  assert.equal(fixtureObject(await refresh.json()).code, "invalid_grant");
}
/** @param {BackendCase} fixture */
export async function localLogout({ integration, a, b, request }) {
  const oldCookie = new Jar();
  for (const [name, value] of a.values) oldCookie.values.set(name, value);
  assert.equal(
    (await integration.write(a, request(), (context) => context.auth.signOut())).error,
    null,
  );
  assert.equal(a.values.size, 0);
  const afterLogout = await integration.read(oldCookie, (context) =>
    context.client.from("next_notes").select().execute(),
  );
  assert.equal(afterLogout.error, null);
  assert.deepEqual(afterLogout.data, []);
  const unwritable = new Jar();
  for (const [name, value] of b.values) unwritable.values.set(name, value);
  unwritable.set = () => {
    throw new Error("Injected cookie publication failure");
  };
  await assert.rejects(
    integration.write(unwritable, request(), (context) =>
      context.auth.updateUser({ data: { marker: "accepted-before-cookie-failure" } }),
    ),
    { code: "session_store" },
  );
  assert.equal(
    (await integration.read(b, (context) => context.getUser())).data?.user_metadata.marker,
    "accepted-before-cookie-failure",
  );
}
