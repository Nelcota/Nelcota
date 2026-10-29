import assert from "node:assert/strict";
/** @typedef {{Integration: typeof import("../src/context.js").Integration, DevelopmentSessionStore: typeof import("../src/memory-store.js").DevelopmentSessionStore}} EdgeRuntime */
/** Checks opaque cookies, CSRF rejection and lease disposal in the browser realm.
 * @param {EdgeRuntime} runtime @param {string} secret */
export async function verifyEdgeSession({ Integration, DevelopmentSessionStore }, secret) {
  const store = new DevelopmentSessionStore(),
    session = edgeSession();
  const { values, cookies } = cookieJar();
  const integration = await edgeIntegration({ Integration, store, session, secret });
  const post = new Request("http://localhost:3000/auth/signin", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
  });
  const signedIn = await integration.write(cookies, post, (context) =>
    context.auth.signInWithPassword({ email: session.user.email, password: "test" }),
  );
  assert.equal(signedIn.data?.id, "edge-user");
  await integration.read(cookies, (context) => {
    assert.equal(context.hasSession, true);
    return Promise.resolve();
  });
  assert.equal(
    [...values.values()].every((value) => /^[A-Za-z0-9_-]{43}$/.test(value)),
    true,
  );
  await assert.rejects(
    integration.write(
      cookies,
      new Request("http://localhost:3000/auth/signin", {
        method: "POST",
        headers: { origin: "https://attacker.test" },
      }),
      () => Promise.resolve(),
    ),
  );
  await integration.write(cookies, post, (context) => context.auth.signOut());
  await integration.read(cookies, (context) => {
    assert.equal(context.hasSession, false);
    return Promise.resolve();
  });
}
function cookieJar() {
  /** @type {Map<string, string>} */
  const values = new Map();
  /** @type {import("../src/context.js").CookieWriter} */
  const cookies = {
    get: (name) => {
      const value = values.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name, value, options) => {
      if (options.maxAge === 0) {
        values.delete(name);
        return;
      }
      values.set(name, value);
    },
  };

  return { values, cookies };
}
/** @returns {import("@nelcota/client").Session} */
function edgeSession() {
  const user = {
    id: "edge-user",
    email: "edge@example.test",
    email_confirmed_at: null,
    user_metadata: {},
    created_at: "",
    last_sign_in_at: null,
  };
  return {
    access_token: "edge-access",
    refresh_token: "edge-refresh",
    token_type: "bearer",
    expires_in: 900,
    expires_at: Math.floor(Date.now() / 1000) + 900,
    user,
  };
}
/** @param {{Integration: EdgeRuntime["Integration"], store: import("../src/memory-store.js").DevelopmentSessionStore, session: import("@nelcota/client").Session, secret: string}} fixture */
async function edgeIntegration({ Integration, store, session, secret }) {
  return await Integration.create({
    url: "http://localhost:8000",
    appOrigin: "http://localhost:3000",
    keys: [secret],
    store,
    allowInsecureDevelopment: true,
    fetch: (url) =>
      new Promise((resolve) =>
        resolve(
          (url instanceof Request ? url.url : url.toString()).includes("/token")
            ? Response.json(session)
            : Response.json(session.user),
        ),
      ),
  });
}
