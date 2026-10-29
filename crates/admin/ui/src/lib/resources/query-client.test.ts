import { afterEach, expect, it } from "vitest";

import { promiseResult } from "../contracts/promise-result.js";
import { requiredValue } from "../contracts/required-value.js";
import { clearQuerySession, invalidateReads, queryRead } from "./query-client";

afterEach(clearQuerySession);

it("deduplicates reads and isolates editable rows from the cache", async () => {
  let calls = 0;
  const fetcher = () => {
    return promiseResult(() => {
      calls++;
      return { rows: [{ value: "original" }] };
    });
  };
  const [first, second] = await Promise.all([
    queryRead({ path: "/rows", account: "admin" }, fetcher),
    queryRead({ path: "/rows", account: "admin" }, fetcher),
  ]);
  requiredValue(first.rows[0], "test fixture item").value = "edited";
  expect(requiredValue(second.rows[0], "test fixture item").value).toBe("original");
  expect(
    requiredValue(
      (await queryRead({ path: "/rows", account: "admin" }, fetcher)).rows[0],
      "test fixture item",
    ).value,
  ).toBe("original");
  expect(calls).toBe(1);
  invalidateReads();
  await queryRead({ path: "/rows", account: "admin" }, fetcher);
  expect(calls).toBe(2);
});

it("cancelling one subscriber preserves another subscriber", async () => {
  let finish!: (value: string) => void;
  const fetcher = () =>
    new Promise<string>((resolve) => {
      finish = resolve;
    });
  const controller = new AbortController();
  const first = queryRead({ path: "/shared", account: "admin" }, fetcher, {
    signal: controller.signal,
  });
  const second = queryRead({ path: "/shared", account: "admin" }, fetcher);
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  finish("data");
  await rejected;
  expect(await second).toBe("data");
});

it("discards in-flight and cached private data at a session boundary", async () => {
  let finish!: (value: string) => void;
  const pending = queryRead(
    { path: "/private", account: "admin" },
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const rejected = expect(pending).rejects.toBeDefined();
  clearQuerySession();
  finish("old private data");
  await rejected;
  expect(
    await queryRead({ path: "/private", account: "admin" }, () =>
      promiseResult(() => "new session"),
    ),
  ).toBe("new session");
});

it("starts a fresh read after a mutation while an older read is still pending", async () => {
  let finish!: (value: string) => void;
  const older = queryRead(
    { path: "/rows", account: "admin" },
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  invalidateReads();
  const newer = queryRead({ path: "/rows", account: "admin" }, () =>
    promiseResult(() => "updated"),
  );
  finish("before mutation");
  await older;
  expect(await newer).toBe("updated");
  expect(
    await queryRead({ path: "/rows", account: "admin" }, () => promiseResult(() => "unexpected")),
  ).toBe("updated");
});

it("cancels an abandoned shared request so a retry can start a new one", async () => {
  let finish!: (value: string) => void;
  let upstream!: AbortSignal;
  const controller = new AbortController();
  const abandoned = queryRead(
    { path: "/retry", account: "admin" },
    (signal) => {
      upstream = signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
    { signal: controller.signal },
  );
  const rejected = expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  const retry = queryRead({ path: "/retry", account: "admin" }, () =>
    promiseResult(() => "new request"),
  );
  finish("old request");
  expect(await retry).toBe("new request");
  expect(upstream.aborted).toBe(true);
});

it("observes cancellation triggered while the fetcher starts", async () => {
  const controller = new AbortController();
  await expect(
    queryRead(
      { path: "/immediate", account: "admin" },
      () => {
        return promiseResult(() => {
          controller.abort();
          return "cancelled data";
        });
      },
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});
