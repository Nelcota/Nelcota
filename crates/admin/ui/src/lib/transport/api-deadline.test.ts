import { clearQuerySession } from "$lib/resources/query-client";
import { afterEach, expect, it, vi } from "vitest";

import { promiseResult } from "../contracts/promise-result.js";
import { api } from "./api";

afterEach(() => {
  clearQuerySession();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["GET", "POST"])("bounds a stalled %s without retrying it", async (method) => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  let sent!: () => void;
  const started = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const fetch = vi.fn(
    (_input: RequestInfo | URL, options?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        finish = resolve;
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any value; preserve the caller's cancellation identity.
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
        sent();
      }),
  );
  vi.stubGlobal("fetch", fetch);
  let failure: unknown;
  const pending = (method === "GET" ? api.get("/session") : api.post("/anything")).catch(
    (error) => {
      failure = error;
    },
  );
  try {
    await started;
    await vi.advanceTimersByTimeAsync(60_001);
    expect(failure).toMatchObject({
      status: 504,
      code: method === "GET" ? "request_timeout" : "write_timeout",
    });
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    finish(new Response("{}"));
    await pending;
  }
});

it.each([200, 502])(
  "bounds a stalled response body (%s), including pending source cleanup",
  async (status) => {
    vi.useFakeTimers();
    let close!: () => void;
    let cleaned!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      cleaned = resolve;
    });
    const cancel = vi.fn(() => cleanup);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => controller.close();
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => promiseResult(() => new Response(body, { status }))),
    );
    let failure: unknown;
    const pending = api.post("/anything").catch((error) => {
      failure = error;
    });
    try {
      await vi.advanceTimersByTimeAsync(60_001);
      expect(failure).toMatchObject({ status: 504, code: "write_timeout" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    } finally {
      if (cancel.mock.calls.length === 0) close();
      cleaned();
      await pending;
    }
  },
);

it("releases the deadline and caller listener after a successful response", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, "removeEventListener");
  let sentSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, options?: RequestInit) => {
      return promiseResult(() => {
        sentSignal = options?.signal;
        return new Response('{"ok":true}');
      });
    }),
  );
  expect(await api.post("/anything", {}, { signal: caller.signal })).toEqual({ ok: true });
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  caller.abort();
  await vi.advanceTimersByTimeAsync(60_001);
  expect(sentSignal?.aborted).toBe(false);
});

it("preserves caller cancellation during body reads and removes its deadline", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  const reason = new DOMException("Navigation cancelled the request", "AbortError");
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => promiseResult(() => new Response(body))),
  );
  const pending = api
    .post("/anything", {}, { signal: caller.signal })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(body.locked).toBe(true);
  caller.abort(reason);
  expect(await pending).toBe(reason);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("starts a queued login only after the earlier request has been aborted", async () => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  let sent!: () => void;
  const started = new Promise<void>((resolve) => {
    sent = resolve;
  });
  let aborted = false;
  const fetch = vi.fn((input: RequestInfo | URL, options?: RequestInit) => {
    if ((input instanceof Request ? input.url : input.toString()).endsWith("/login")) {
      expect(aborted).toBe(true);
      return Promise.resolve(new Response('{"email":"new@example.test"}'));
    }
    return new Promise<Response>((resolve, reject) => {
      finish = resolve;
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any value; preserve the caller's cancellation identity.
          reject(options.signal?.reason);
        },
        { once: true },
      );
      sent();
    });
  });
  vi.stubGlobal("fetch", fetch);
  const old = api.post("/logout").catch((error: unknown) => error);
  await started;
  let account: unknown;
  const login = api.post("/login").then((value) => {
    account = value;
  });
  try {
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(account).toEqual({ email: "new@example.test" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    finish(new Response("{}"));
    await old;
    await login;
  }
});

it("does not send a caller request that was already cancelled", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  caller.abort();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(api.post("/anything", {}, { signal: caller.signal })).rejects.toBe(
    caller.signal.reason,
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
