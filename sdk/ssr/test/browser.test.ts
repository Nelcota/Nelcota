import { afterEach, expect, it, vi } from "vitest";

import { refreshSession } from "../src/browser.js";
import { promiseResult } from "../src/lifecycle/promise-result.js";
import { requiredValue } from "../src/required-value.js";

afterEach(() => vi.unstubAllGlobals());
function browser() {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    promiseResult(() => new Response(null, { status: 204 })),
  );
  vi.stubGlobal("location", { origin: "https://app.test" });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it("uses a same-origin bounded POST without JavaScript tokens", async () => {
  const fetch = browser();
  expect((await refreshSession()).status).toBe(204);
  expect(new Request(requiredValue(fetch.mock.calls[0], "recorded request")[0]).url).toBe(
    "https://app.test/auth/session/refresh",
  );
  expect(requiredValue(fetch.mock.calls[0], "recorded request")[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
});
it("refuses foreign/ambiguous refresh endpoints before fetch", async () => {
  const fetch = browser();
  for (const endpoint of [
    "https://evil.test",
    "//evil.test",
    "/.//evil.test",
    "/auth\\refresh",
    "/auth/refresh#secret",
    "/auth/refresh\n",
  ])
    // oxlint-disable-next-line no-await-in-loop -- Keep refresh cases ordered against the shared browser environment fixture.
    await expect(refreshSession({ endpoint })).rejects.toBeInstanceOf(TypeError);
  expect(fetch).not.toHaveBeenCalled();
});
it("validates finite deadlines and passes cancellation to Web Locks", async () => {
  const fetch = browser();
  for (const timeout of [NaN, Infinity, -1, 0, 30001])
    // oxlint-disable-next-line no-await-in-loop -- Keep refresh cases ordered against the shared browser environment fixture.
    await expect(refreshSession({ timeout })).rejects.toBeInstanceOf(TypeError);
  const locks = {
    request: vi.fn(
      (_key: string, options: { signal: AbortSignal }, work: () => Promise<Response>) => {
        return promiseResult(() => {
          options.signal.throwIfAborted();
          return work();
        });
      },
    ),
  };
  vi.stubGlobal("navigator", { locks });
  const controller = new AbortController();
  controller.abort();
  await expect(refreshSession({ signal: controller.signal })).rejects.toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
});
