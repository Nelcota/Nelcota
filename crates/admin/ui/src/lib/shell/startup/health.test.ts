import { afterEach, describe, expect, it, vi } from "vitest";

import { promiseResult } from "../../contracts/promise-result.js";
import { requiredValue } from "../../contracts/required-value.js";
import { environment } from "./health.svelte";

describe("environment", () => {
  it("is local on this machine", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "app.localhost"])
      expect(environment(host)).toEqual({ local: true });
  });

  it("names the host anywhere else", () => {
    expect(environment("db.example.com")).toEqual({ local: false, host: "db.example.com" });
    for (const host of ["127.example.com", "127.999.0.1"])
      expect(environment(host)).toEqual({ local: false, host });
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function monitor(fetcher: typeof fetch) {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  vi.resetModules();
  const window = new EventTarget(),
    document = { visibilityState: "visible" };
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", fetcher);
  const health = await import("./health.svelte");
  health.watchHealth();
  return { ...health, window, document };
}

it("shares an in-flight health check across focus, online and repeated watchers", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const { watchHealth, window } = await monitor(fetcher);
  watchHealth();
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  expect(fetcher).toHaveBeenCalledTimes(1);
  finish(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
});

it("keeps an offline event newer than a pending successful response", async () => {
  let finish!: (value: Response) => void;
  const { health, window } = await monitor(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  window.dispatchEvent(new Event("offline"));
  finish(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(health.status).toBe("offline");
});

it("bounds a hung check and allows another check after the deadline", async () => {
  let firstSignal!: AbortSignal;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          firstSignal = requiredValue(
            requiredValue(init, "required operation value").signal,
            "request signal",
          );
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason may be any value; preserve the caller's cancellation identity.
          firstSignal.addEventListener("abort", () => reject(firstSignal.reason), { once: true });
        }),
    )
    .mockResolvedValue(new Response(null, { status: 200 }));
  const { health, window } = await monitor(fetcher);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(firstSignal.aborted).toBe(true);
  expect(health.status).toBe("offline");
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(health.status).toBe("online");
});

it("throttles rapid focus events and skips interval checks in a hidden tab", async () => {
  const fetcher = vi.fn(() => promiseResult(() => new Response(null, { status: 200 })));
  const { window, document } = await monitor(fetcher);
  await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  document.visibilityState = "hidden";
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  document.visibilityState = "visible";
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("ignores a timed-out success even when fetch ignores cancellation", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(new Response(null, { status: 503 }));
  const { health, window } = await monitor(fetcher);
  await vi.advanceTimersByTimeAsync(10_001);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  finish(new Response(null, { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(health.status).toBe("offline");
});

it("keeps checking when the wall clock moves backwards", async () => {
  const fetcher = vi.fn(() => promiseResult(() => new Response(null, { status: 200 })));
  const { window } = await monitor(fetcher);
  await vi.advanceTimersByTimeAsync(6000);
  vi.setSystemTime(new Date(Date.now() - 60_000));
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
