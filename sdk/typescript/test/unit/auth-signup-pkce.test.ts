import { afterEach, expect, it, vi } from "vitest";

import { challengeFor } from "../../src/auth/pkce.js";
import { requiredValue } from "../../src/core/required-value.js";
import { createClient, memoryStorage } from "../../src/index.js";
import { KEY, setup } from "./auth-fixtures.js";
import { installWebLocks, nativeBrowserStorage } from "./browser-environment.js";
import { json, mockFetch, session, type Recorded } from "./http-fixtures.js";

const SIGNUP_KEY = `${KEY}.signup`;
afterEach(() => vi.unstubAllGlobals());
const pending = () => json({ user: session().user }, 201);

function body(call: Recorded | undefined): Record<string, unknown> {
  return JSON.parse(requiredValue(requiredValue(call, "request").body, "request body")) as Record<
    string,
    unknown
  >;
}

it("sign-up PKCE: binds the confirmation link to this client's stored verifier", async () => {
  const { nelcota, calls, storage } = setup(memoryStorage(), pending(), json(session()));
  try {
    await nelcota.auth.signUp({ email: "ana@example.com", password: "pw" });
    const verifier = requiredValue(await storage.getItem(SIGNUP_KEY), "stored verifier");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(body(calls[0])).toMatchObject({
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
    });
    expect(await storage.getItem(`${KEY}.pkce`)).toBeNull();

    const confirmed = await nelcota.auth.verifyEmailLink({ type: "signup", token: "t1" });
    expect(confirmed.error).toBeNull();
    expect(body(calls[1])).toEqual({ type: "signup", token: "t1", code_verifier: verifier });
    expect(await storage.getItem(SIGNUP_KEY)).toBeNull();
  } finally {
    nelcota.dispose();
  }
});

it("sign-up PKCE: keeps the verifier when a confirmation fails, so the link can be retried", async () => {
  let offline = true;
  const { nelcota, calls, storage } = setup(memoryStorage(), pending(), () => {
    if (offline) throw new TypeError("network down");
    return json(session());
  });
  try {
    await nelcota.auth.signUp({ email: "ana@example.com", password: "pw" });
    const verifier = await storage.getItem(SIGNUP_KEY);
    expect((await nelcota.auth.verifyEmailLink({ type: "signup", token: "t1" })).error).not.toBe(
      null,
    );
    expect(await storage.getItem(SIGNUP_KEY)).toBe(verifier);
    offline = false;
    expect((await nelcota.auth.verifyEmailLink({ type: "signup", token: "t1" })).error).toBeNull();
    expect(body(calls.at(-1))).toMatchObject({ code_verifier: verifier });
    expect(await storage.getItem(SIGNUP_KEY)).toBeNull();
  } finally {
    nelcota.dispose();
  }
});

it("sign-up PKCE: keeps the verifier after a refused link", async () => {
  const { nelcota, storage } = setup(
    memoryStorage(),
    pending(),
    json({ code: "invalid_grant", message: "invalid or expired link" }, 400),
  );
  try {
    await nelcota.auth.signUp({ email: "ana@example.com", password: "pw" });
    const verifier = await storage.getItem(SIGNUP_KEY);
    const result = await nelcota.auth.verifyEmailLink({ type: "signup", token: "old" });
    expect(result.error?.code).toBe("invalid_grant");
    expect(await storage.getItem(SIGNUP_KEY)).toBe(verifier);
  } finally {
    nelcota.dispose();
  }
});

it("sign-up PKCE: forgets the verifier when sign-up signs in at once", async () => {
  const { nelcota, storage } = setup(memoryStorage(), json(session(), 201));
  try {
    const { data } = await nelcota.auth.signUp({ email: "ana@example.com", password: "pw" });
    expect(data?.session).not.toBeNull();
    expect(await storage.getItem(SIGNUP_KEY)).toBeNull();
  } finally {
    nelcota.dispose();
  }
});

it("sign-up PKCE: magic links and confirmations without a verifier send none", async () => {
  const storage = memoryStorage();
  await storage.setItem(SIGNUP_KEY, "v".repeat(64));
  const { nelcota, calls } = setup(storage, json(session()));
  const other = setup(memoryStorage(), json(session()));
  try {
    await nelcota.auth.verifyEmailLink({ type: "magiclink", token: "t1" });
    expect(body(calls[0])).toEqual({ type: "magiclink", token: "t1" });
    expect(await storage.getItem(SIGNUP_KEY)).toBe("v".repeat(64));

    await other.nelcota.auth.verifyEmailLink({ type: "signup", token: "t2" });
    expect(body(other.calls[0])).toEqual({ type: "signup", token: "t2" });
  } finally {
    nelcota.dispose();
    other.nelcota.dispose();
  }
});

it("sign-up PKCE: a pending sign-up does not make an app's ?code= look like an OAuth callback", async () => {
  const { nelcota, calls } = setup(memoryStorage(), pending());
  try {
    await nelcota.auth.signUp({ email: "ana@example.com", password: "pw" });
    const result = await nelcota.auth.handleRedirect("https://app.example.com/?code=app-owned");
    expect(result).toEqual({ data: null, error: null });
    expect(calls).toHaveLength(1);
  } finally {
    nelcota.dispose();
  }
});

it("sign-up PKCE: a browser tab opening the link uses the verifier another tab stored", async () => {
  const storage = nativeBrowserStorage();
  installWebLocks();
  const mock = mockFetch(pending(), json(session()));
  const [signingUp, confirming] = [0, 1].map(() =>
    createClient("https://api.example.com", { fetch: mock.fetch, auth: { autoRefresh: false } }),
  );
  try {
    await requiredValue(signingUp, "client").auth.signUp({ email: "a@x.com", password: "pw" });
    const verifier = storage.getItem(SIGNUP_KEY);
    expect(verifier).not.toBeNull();
    const link = { type: "signup", token: "t1" } as const;
    expect((await requiredValue(confirming, "client").auth.verifyEmailLink(link)).error).toBeNull();
    expect(body(mock.calls[1])).toMatchObject({ code_verifier: verifier });
    expect(storage.getItem(SIGNUP_KEY)).toBeNull();
  } finally {
    signingUp?.dispose();
    confirming?.dispose();
  }
});

it("sign-up PKCE: storage without the sign-up slot (an older adapter) still signs up and confirms", async () => {
  const backing = memoryStorage();
  const refuse = (key: string) => {
    if (key === SIGNUP_KEY) throw new Error("Unexpected session storage key");
  };
  const storage = {
    getItem: async (key: string) => {
      refuse(key);
      return await backing.getItem(key);
    },
    setItem: async (key: string, value: string) => {
      refuse(key);
      await backing.setItem(key, value);
    },
    removeItem: async (key: string) => {
      refuse(key);
      await backing.removeItem(key);
    },
  };
  const { nelcota, calls } = setup(storage, pending(), json(session()));
  try {
    expect((await nelcota.auth.signUp({ email: "a@x.com", password: "pw" })).error).toBeNull();
    expect(body(calls[0])).not.toHaveProperty("code_challenge");
    const confirmed = await nelcota.auth.verifyEmailLink({ type: "signup", token: "t1" });
    expect(confirmed.error).toBeNull();
    expect(body(calls[1])).toEqual({ type: "signup", token: "t1" });
    expect((await nelcota.auth.getSession()).data?.access_token).toBe("access-1");
  } finally {
    nelcota.dispose();
  }
});

it("sign-up PKCE: a failed verifier removal keeps the confirmed session", async () => {
  const backing = memoryStorage();
  const storage = {
    ...backing,
    removeItem: async (key: string) => {
      if (key === SIGNUP_KEY) throw new Error("removal failed");
      await backing.removeItem(key);
    },
  };
  const { nelcota } = setup(storage, pending(), json(session()));
  try {
    await nelcota.auth.signUp({ email: "a@x.com", password: "pw" });
    const confirmed = await nelcota.auth.verifyEmailLink({ type: "signup", token: "t1" });
    expect(confirmed.error).toBeNull();
    expect((await nelcota.auth.getSession()).data?.access_token).toBe("access-1");
  } finally {
    nelcota.dispose();
  }
});
