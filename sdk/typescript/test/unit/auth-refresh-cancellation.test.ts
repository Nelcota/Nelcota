import { afterEach, expect, it, vi } from "vitest";

import { parseSession } from "../../src/auth/session.js";
import { requiredValue } from "../../src/core/required-value.js";
import { createClient } from "../../src/index.js";
import { KEY, setup, stored } from "./auth-fixtures.js";
import { empty, json, mockFetch, session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("refresh: cancels each waiter independently and persists an accepted rotation", async () => {
  let started!: () => void, finish!: (response: Response) => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  let requestSignal: AbortSignal | null | undefined;
  let calls = 0;
  const storage = stored(session(30));
  const nelcota = createClient("https://api.example.com", {
    auth: { storage, autoRefresh: false },
    fetch: async (_input, init) => {
      calls++;
      requestSignal = init?.signal;
      started();
      return await new Promise<Response>((resolve, reject) => {
        finish = resolve;
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any value; preserve the caller's cancellation identity.
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    },
  });
  const controller = new AbortController();
  const cancelled = nelcota.auth.refreshSession({ signal: controller.signal });
  await begun;
  const survivor = nelcota.auth.refreshSession();
  try {
    controller.abort();
    expect((await cancelled).error?.code).toBe("aborted");
    expect(requestSignal?.aborted).not.toBe(true);
    finish(json(session(900, "refresh-2", "access-2")));
    expect((await survivor).data?.refresh_token).toBe("refresh-2");
    expect(
      requiredValue(
        parseSession(requiredValue(await storage.getItem(KEY), "stored session")),
        "stored session",
      ).refresh_token,
    ).toBe("refresh-2");
    expect(calls).toBe(1);
  } finally {
    finish(json(session(900, "refresh-2", "access-2")));
    nelcota.dispose();
  }
});

it("refresh: does not start a rotation for an already cancelled caller", async () => {
  const { nelcota, calls } = setup(stored(session(30)), json(session()));
  const controller = new AbortController();
  controller.abort();
  expect((await nelcota.auth.refreshSession({ signal: controller.signal })).error?.code).toBe(
    "aborted",
  );
  expect((await nelcota.auth.getSession({ signal: controller.signal })).error?.code).toBe(
    "aborted",
  );
  expect(calls).toHaveLength(0);
  nelcota.dispose();
});

it("refresh: cancels getSession while another caller holds the lifecycle lock", async () => {
  vi.useFakeTimers();
  let started!: () => void, finish!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { nelcota } = setup(stored(session(30)), async () => {
    started();
    await wait;
    return json(session(900, "refresh-2", "access-2"));
  });
  const refresh = nelcota.auth.refreshSession();
  await begun;
  const controller = new AbortController();
  let code: string | undefined;
  const pending = nelcota.auth.getSession({ signal: controller.signal }).then((result) => {
    code = result.error?.code;
  });
  try {
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(code).toBe("aborted");
  } finally {
    finish();
    await Promise.all([refresh, pending]);
    nelcota.dispose();
    vi.useRealTimers();
  }
});

it("refresh: coordinates clients sharing an adapter without Web Locks", async () => {
  vi.stubGlobal("navigator", {});
  const storage = stored(session(30));
  let refreshes = 0;
  const reply = async () => {
    const delayInMs = 15;

    refreshes++;
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
    return json(session(900, "refresh-2", "access-2"));
  };
  const a = setup(storage, reply);
  const b = setup(storage, reply);
  const results = await Promise.all([a.nelcota.auth.getSession(), b.nelcota.auth.getSession()]);
  expect(refreshes).toBe(1);
  expect(results.map((result) => result.data?.refresh_token)).toEqual(["refresh-2", "refresh-2"]);
});

it("refresh: does not restore a session when logout overlaps a refresh", async () => {
  let started!: () => void;
  let finish!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { nelcota, storage } = setup(stored(session(30)), async (request) => {
    if (request.url.pathname !== "/auth/v1/token") return empty();
    started();
    await wait;
    return json(session(900, "refresh-2", "access-2"));
  });
  const refresh = nelcota.auth.refreshSession();
  await begun;
  const logout = nelcota.auth.signOut();
  finish();
  expect((await refresh).error).toBeNull();
  expect((await logout).error).toBeNull();
  expect((await nelcota.auth.getSession()).data).toBeNull();
  expect(await storage.getItem(KEY)).toBeNull();
});

it("refresh: does not rearm background timers after dispose during refresh", async () => {
  vi.useFakeTimers();
  try {
    const mock = mockFetch(json(session(900, "refresh-2", "access-2")));
    const nelcota = createClient("https://api.example.com", {
      fetch: mock.fetch,
      auth: { autoRefresh: true },
    });
    await nelcota.auth.setSession(session(120));
    const refresh = nelcota.auth.refreshSession();
    nelcota.dispose();
    await refresh;
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(mock.calls).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
