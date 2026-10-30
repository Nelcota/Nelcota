import { afterEach, expect, it, vi } from "vitest";

import { challengeFor } from "../../src/auth/pkce.js";
import { requiredValue } from "../../src/core/required-value.js";
import { memoryStorage, NelcotaUsageError, type SessionStorage } from "../../src/index.js";
import { KEY, setup } from "./auth-fixtures.js";
import { gate as controlGate } from "./gate.js";
import { json, session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("OAuth with PKCE: cannot erase a new OAuth verifier while consuming the previous callback", async () => {
  const stored = memoryStorage();
  await stored.setItem(`${KEY}.pkce`, "v".repeat(64));
  let reading = false;
  const { promise: gate, open: release } = controlGate();
  const storage: SessionStorage = {
    ...stored,
    async getItem(key) {
      const value = await stored.getItem(key);
      if (key === `${KEY}.pkce` && reading === false) {
        reading = true;
        await gate;
      }
      return value;
    },
  };
  const first = setup(storage, json(session())).nelcota,
    second = setup(storage).nelcota;
  try {
    const callback = first.auth.exchangeCode("old-code");
    await vi.waitFor(() => expect(reading).toBe(true));
    const login = second.auth.signInWithOAuth({
      provider: "github",
      redirectTo: "https://app.example.com/back",
      redirect: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    release();
    const [exchanged, started] = await Promise.all([callback, login]);
    expect(exchanged.error).toBeNull();
    const verifier = await stored.getItem(`${KEY}.pkce`);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(
      new URL(requiredValue(started.data, "response data").url).searchParams.get("code_challenge"),
    ).toBe(await challengeFor(requiredValue(verifier, "required operation value")));
  } finally {
    release();
    first.dispose();
    second.dispose();
  }
});

it("OAuth with PKCE: keeps navigation ordered with verifier publication across clients", async () => {
  const storage = memoryStorage();
  const first = setup(storage).nelcota,
    second = setup(storage).nelcota;
  const navigations: string[] = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("location", { assign: (url: string) => navigations.push(url) });

  const { promise: gate, open: release } = controlGate();
  let digests = 0;
  const original = globalThis.crypto;
  const digest = vi.fn(async () => {
    const number = ++digests;
    if (number === 1) await gate;
    return new Uint8Array(32).fill(number).buffer;
  });
  vi.stubGlobal("crypto", {
    getRandomValues: original.getRandomValues.bind(original),
    subtle: { digest },
  });
  try {
    const a = first.auth.signInWithOAuth({
      provider: "github",
      redirectTo: "https://app.example.com/back",
    });
    await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
    const b = second.auth.signInWithOAuth({
      provider: "google",
      redirectTo: "https://app.example.com/back",
    });
    // Flush the second call's microtasks while the first digest is suspended.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([a, b]);
    expect(navigations.map((url) => new URL(url).searchParams.get("provider"))).toEqual([
      "github",
      "google",
    ]);
    expect(
      new URL(requiredValue(navigations.at(-1), "required operation value")).searchParams.get(
        "code_challenge",
      ),
    ).toBe(Buffer.from(new Uint8Array(32).fill(2)).toString("base64url"));
  } finally {
    release();
    first.dispose();
    second.dispose();
  }
});

it("OAuth with PKCE: builds the authorize URL with an S256 challenge of a stored verifier", async () => {
  const { nelcota, storage } = setup();
  const { data } = await nelcota.auth.signInWithOAuth({
    provider: "github",
    redirectTo: "https://app.example.com/back",
  });
  const url = new URL(requiredValue(data, "response data").url);
  expect(url.origin + url.pathname).toBe("https://api.example.com/auth/v1/authorize");
  expect(url.searchParams.get("provider")).toBe("github");
  expect(url.searchParams.get("redirect_to")).toBe("https://app.example.com/back");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const verifier = requiredValue(await storage.getItem(`${KEY}.pkce`), "stored session");
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
  expect(url.searchParams.get("code_challenge")).toBe(await challengeFor(verifier));
});

it("OAuth with PKCE: exchanges the code once with the verifier, then forgets the verifier", async () => {
  const { nelcota, calls, storage } = setup(memoryStorage(), json(session()));
  await storage.setItem(`${KEY}.pkce`, "v".repeat(64));
  const { data } = await nelcota.auth.handleRedirect("https://app.example.com/back?code=abc&x=1");
  expect(data?.access_token).toBe("access-1");
  expect(requiredValue(calls[0], "recorded test item").url.search).toBe("?grant_type=pkce");
  expect(
    JSON.parse(
      requiredValue(requiredValue(calls[0], "recorded test item").body, "request body"),
    ) as unknown,
  ).toEqual({ auth_code: "abc", code_verifier: "v".repeat(64) });
  expect(await storage.getItem(`${KEY}.pkce`)).toBeNull();
  expect((await nelcota.auth.exchangeCode("abc")).error?.code).toBe("pkce_missing");
});

it("OAuth with PKCE: refuses a relative redirectTo and tolerates a missing page URL", async () => {
  const { nelcota } = setup();
  await expect(
    nelcota.auth.signInWithOAuth({ provider: "google", redirectTo: "/back" }),
  ).rejects.toThrow(NelcotaUsageError);
  // Outside a browser there is no location: nothing to handle.
  expect(await nelcota.auth.handleRedirect()).toEqual({ data: null, error: null });
  expect(nelcota.auth.readEmailLink()).toBeNull();
});

it("OAuth with PKCE: reports provider errors and ignores unrelated URLs", async () => {
  const { nelcota, calls, storage } = setup();
  await storage.setItem(`${KEY}.pkce`, "v".repeat(64));
  expect(
    (await nelcota.auth.handleRedirect("https://app.example.com/back?error=access_denied")).error
      ?.code,
  ).toBe("access_denied");
  // The provider ended that sign-in: its verifier is gone.
  expect(await storage.getItem(`${KEY}.pkce`)).toBeNull();
  expect(await nelcota.auth.handleRedirect("https://app.example.com/other")).toEqual({
    data: null,
    error: null,
  });
  expect(calls).toHaveLength(0);
});

it("OAuth with PKCE: maps unknown redirect error codes to oauth_error with sanitized details", async () => {
  const { nelcota, storage } = setup();
  await storage.setItem(`${KEY}.pkce`, "v".repeat(64));
  const raw = `<script>${"x".repeat(100)}`;
  const { error } = await nelcota.auth.handleRedirect(
    `https://app.example.com/back?error=${encodeURIComponent(raw)}`,
  );
  expect(error?.code).toBe("oauth_error");
  expect(error?.details).toBe(`_script_${"x".repeat(56)}`);
});

it("OAuth with PKCE: leaves a code parameter alone when no sign-in is pending", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  const href = "https://app.example.com/orders?code=SPRING-SALE";
  const replaceState = vi.fn();
  vi.stubGlobal("location", { href });
  vi.stubGlobal("history", { state: null, replaceState });
  const { nelcota, calls } = setup();
  try {
    expect(await nelcota.auth.handleRedirect(href)).toEqual({ data: null, error: null });
    expect(
      (await nelcota.auth.handleRedirect("https://app.example.com/back?error=access_denied")).error,
    ).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  } finally {
    nelcota.dispose();
  }
});

it("OAuth with PKCE: keeps the verifier after an uncertain exchange so the callback can retry", async () => {
  const { nelcota, calls, storage } = setup(
    memoryStorage(),
    json({ code: "unavailable", message: "Busy" }, 503),
    json(session()),
    json({ code: "invalid_grant", message: "Code already used" }, 400),
  );
  await storage.setItem(`${KEY}.pkce`, "v".repeat(64));
  expect((await nelcota.auth.exchangeCode("abc")).error?.status).toBe(503);
  expect(await storage.getItem(`${KEY}.pkce`)).toBe("v".repeat(64));
  expect((await nelcota.auth.exchangeCode("abc")).error).toBeNull();
  expect(await storage.getItem(`${KEY}.pkce`)).toBeNull();
  await storage.setItem(`${KEY}.pkce`, "w".repeat(64));
  expect((await nelcota.auth.exchangeCode("abc")).error?.code).toBe("invalid_grant");
  // A definite refusal ends that sign-in.
  expect(await storage.getItem(`${KEY}.pkce`)).toBeNull();
  expect(calls).toHaveLength(3);
});

it("OAuth with PKCE: the S256 challenge is base64url(SHA-256(verifier)) without padding", async () => {
  const { createHash } = await import("node:crypto");
  for (const verifier of [
    "a".repeat(43),
    "dBjftJeZ4CVP-mJ92K-1yLtDy1Y-ry9Lm1uTJ3mMkI8",
    "x_~.-".repeat(20),
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Publish the current auth transition before advancing the shared session fixture.
    expect(await challengeFor(verifier)).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  }
});
