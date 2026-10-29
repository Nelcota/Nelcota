import { expect, it } from "vitest";

import { promiseResult } from "../contracts/promise-result.js";
import { RemoteResource } from "./remote-resource.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it("remote resources: keeps a loaded response as the same plain object instead of a deep proxy", async () => {
  const resource = new RemoteResource<{ rows: { id: number }[] }>();
  const payload = { rows: [{ id: 1 }] };
  await resource.load(() => promiseResult(() => payload));
  expect(resource.data).toBe(payload);
});

it("remote resources: ignores obsolete responses even when the adapter ignores abort", async () => {
  const resource = new RemoteResource<string>();
  const old = deferred<string>(),
    current = deferred<string>();
  let signal!: AbortSignal;
  const first = resource.load((s) => {
    signal = s;
    return old.promise;
  });
  const second = resource.load(() => current.promise);
  expect(signal.aborted).toBe(true);
  old.resolve("old");
  await first;
  expect(resource.loading).toBe(true);
  expect(resource.data).toBeNull();
  current.resolve("current");
  await second;
  expect(resource.data).toBe("current");
  expect(resource.loading).toBe(false);
});

it("remote resources: keeps the last good result on failure, clears errors on retry, and cancels on navigation", async () => {
  const resource = new RemoteResource<string>();
  await resource.load(() => promiseResult(() => "good"));
  await resource.load(() => {
    return promiseResult(() => {
      throw new Error("offline");
    });
  });
  expect(resource.data).toBe("good");
  expect(resource.error).toBeInstanceOf(Error);
  const pending = deferred<string>();
  const load = resource.load(() => pending.promise);
  expect(resource.error).toBeNull();
  resource.clear();
  pending.reject(new Error("too late"));
  await load;
  expect(resource.data).toBeNull();
  expect(resource.error).toBeNull();
  expect(resource.loaded).toBe(false);
});

it("remote resources: reports a request timeout as an error, unlike a cancellation", async () => {
  const resource = new RemoteResource<string>();
  const loaded = await resource.load(() => {
    return promiseResult(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
  });
  expect(loaded).toBe(false);
  expect(resource.error).toMatchObject({ name: "TimeoutError" });
  expect(resource.loading).toBe(false);
});
