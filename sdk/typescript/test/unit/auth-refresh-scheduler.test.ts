import { afterEach, expect, it, vi } from "vitest";

import { createClient } from "../../src/index.js";
import { stored } from "./auth-fixtures.js";
import { json, mockFetch, session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("refresh: refreshes in the background before expiry", async () => {
  vi.useFakeTimers();
  try {
    const mock = mockFetch(json(session(900, "refresh-2", "access-2")));
    const nelcota = createClient("https://api.example.com", {
      fetch: mock.fetch,
      auth: { storage: stored(session(120)), autoRefresh: true, refreshMargin: 60 },
    });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(mock.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(mock.calls).toHaveLength(1);
    expect((await nelcota.auth.getSession()).data?.access_token).toBe("access-2");
    nelcota.auth.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it.each([30, 900])(
  "refresh: bounds the refresh margin by the %s-second token lifetime",
  async (lifetime) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fresh = () => ({ ...session(lifetime), expires_in: lifetime });
    const mock = mockFetch(() => json(fresh()));
    const nelcota = createClient("https://api.example.com", {
      fetch: mock.fetch,
      auth: { autoRefresh: true, refreshMargin: 3600 },
    });
    try {
      await nelcota.auth.setSession(fresh());
      await nelcota.auth.getSession();
      expect(mock.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(lifetime * 500 - 1);
      expect(mock.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(mock.calls).toHaveLength(1);
      await nelcota.auth.getSession();
      expect(mock.calls).toHaveLength(1);
    } finally {
      nelcota.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  },
);

it("refresh: retries an uncertain background refresh inside the server reuse window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  // The rotation may have committed before the 503: only a retry under 10 s recovers it.
  const mock = mockFetch(
    json({ message: "gateway" }, 503),
    json(session(900, "refresh-2", "access-2")),
  );
  const nelcota = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: true, refreshMargin: 60 },
  });
  try {
    await nelcota.auth.setSession(session(61));
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.calls).toHaveLength(2);
    expect((await nelcota.auth.getSession()).data?.access_token).toBe("access-2");
  } finally {
    nelcota.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it("refresh: backs off when the server returns an already expired token", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  const expired = () => ({ ...session(0), expires_in: 0 });
  const mock = mockFetch(
    () => json(expired()),
    json({ code: "invalid_grant", message: "stop unexpected rotation" }, 400),
  );
  const nelcota = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: true },
  });
  try {
    await nelcota.auth.setSession(expired());
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.calls.length).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.calls).toHaveLength(1);
  } finally {
    nelcota.dispose();
    vi.useRealTimers();
  }
});
