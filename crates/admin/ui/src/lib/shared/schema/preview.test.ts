import { afterEach, expect, it, vi } from "vitest";

import { promiseResult } from "../../contracts/promise-result.js";
import type { DdlResult } from "./ddl";
import { SqlPreview } from "./preview.svelte";

afterEach(() => {
  vi.useRealTimers();
});

function deferred() {
  let resolve!: (value: DdlResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DdlResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const result = (sql: string): DdlResult => ({ sql: [sql], applied: false, catalog_pending: false });

it("discards an older response as soon as a new preview is scheduled", async () => {
  vi.useFakeTimers();
  const preview = new SqlPreview(),
    older = deferred();
  let signal!: AbortSignal;
  preview.schedule((current) => {
    signal = current;
    return older.promise;
  });
  await vi.advanceTimersByTimeAsync(350);
  preview.schedule(() => promiseResult(() => result("new SQL")));
  expect(signal.aborted).toBe(true);
  older.resolve(result("old SQL"));
  await vi.advanceTimersByTimeAsync(0);
  expect(preview.sql).toBeNull();
  await vi.advanceTimersByTimeAsync(350);
  expect(preview.sql).toEqual(["new SQL"]);
  preview.clear();
});

it.each(["response", "failure"])(
  "keeps a cleared preview empty after a late %s",
  async (completion) => {
    vi.useFakeTimers();
    const preview = new SqlPreview(),
      pending = deferred();
    preview.schedule(() => pending.promise);
    await vi.advanceTimersByTimeAsync(350);
    preview.clear();
    if (completion === "response") pending.resolve(result("closed form SQL"));
    if (completion === "failure") pending.reject(new Error("old failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(preview.sql).toBeNull();
    expect(preview.error).toBe("");
    expect(preview.loading).toBe(false);
  },
);

it("debounces edits and cancels a preview before it starts", async () => {
  vi.useFakeTimers();
  const preview = new SqlPreview(),
    request = vi.fn(() => promiseResult(() => result("SQL")));
  preview.schedule(request);
  await vi.advanceTimersByTimeAsync(200);
  preview.schedule(request);
  await vi.advanceTimersByTimeAsync(200);
  expect(request).not.toHaveBeenCalled();
  preview.clear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(request).not.toHaveBeenCalled();
});

it("preserves the newer preview when an adapter ignores cancellation", async () => {
  vi.useFakeTimers();
  const preview = new SqlPreview(),
    older = deferred();
  preview.schedule(() => older.promise);
  await vi.advanceTimersByTimeAsync(350);
  preview.schedule(() => promiseResult(() => result("new SQL")));
  await vi.advanceTimersByTimeAsync(350);
  older.reject(new Error("old failure"));
  await vi.advanceTimersByTimeAsync(0);
  expect(preview.sql).toEqual(["new SQL"]);
  expect(preview.error).toBe("");
  preview.clear();
});
