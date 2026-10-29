import { afterEach, expect, it, vi } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { createClient, memoryStorage } from "../../src/index.js";
import { stored } from "./auth-fixtures.js";
import { json, mockFetch, session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([false, true, "async"])(
  "background adapter failures: observes startup storage failure and isolates its handler (throws: %s)",
  async (throws) => {
    vi.useFakeTimers();
    const failed = new Error("storage unavailable");
    const storage = memoryStorage();
    vi.spyOn(storage, "getItem").mockRejectedValue(failed);
    const onBackgroundError = vi.fn(() => {
      if (throws === "async") return Promise.reject(new Error("handler failed"));
      if (throws === true) throw new Error("handler failed");
    });
    const nelcota = createClient("https://api.example.com", {
      auth: { storage, autoRefresh: true, onBackgroundError },
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(onBackgroundError).toHaveBeenCalledExactlyOnceWith(failed);
      expect(vi.getTimerCount()).toBe(0);
      await expect(nelcota.auth.getSession()).rejects.toBe(failed);
    } finally {
      nelcota.dispose();
      vi.useRealTimers();
    }
  },
);

it("background adapter failures: pauses on a failed background write and resumes with the replacement token", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  const channel: {
    onmessage?: (event: { data: string }) => void;
    close: () => void;
    postMessage: () => void;
  } = { close() {}, postMessage() {} };
  vi.stubGlobal("BroadcastChannel", function BroadcastChannelFixture() {
    return channel;
  });
  const storage = stored(session(120));
  const failed = new Error("storage unavailable");
  vi.spyOn(storage, "setItem").mockRejectedValueOnce(failed);
  const onBackgroundError = vi.fn();
  const mock = mockFetch(
    json(session(900, "refresh-2", "access-2")),
    json(session(900, "refresh-3", "access-3")),
  );
  const nelcota = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { storage, autoRefresh: true, onBackgroundError },
  });
  try {
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onBackgroundError).toHaveBeenCalledExactlyOnceWith(failed);
    expect((await nelcota.auth.getSession()).data?.refresh_token).toBe("refresh-2");
    expect(vi.getTimerCount()).toBe(0);
    channel.onmessage?.({ data: "changed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await nelcota.auth.refreshSession();
    expect(
      JSON.parse(
        requiredValue(requiredValue(mock.calls[1], "recorded test item").body, "request body"),
      ) as unknown,
    ).toMatchObject({ refresh_token: "refresh-2" });
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    nelcota.dispose();
    vi.useRealTimers();
  }
});

it("background adapter failures: observes a failed reload from another tab even without auto-refresh", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  const channel: {
    onmessage?: (event: { data: string }) => void;
    close: () => void;
    postMessage: () => void;
  } = { close() {}, postMessage() {} };
  vi.stubGlobal("BroadcastChannel", function BroadcastChannelFixture() {
    return channel;
  });
  const storage = stored(session());
  const failed = new Error("storage unavailable");
  const onBackgroundError = vi.fn();
  const nelcota = createClient("https://api.example.com", {
    auth: { storage, autoRefresh: false, onBackgroundError },
  });
  try {
    await nelcota.auth.getSession();
    vi.spyOn(storage, "getItem").mockRejectedValueOnce(failed);
    channel.onmessage?.({ data: "changed" });
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalledExactlyOnceWith(failed));
  } finally {
    nelcota.dispose();
  }
});
