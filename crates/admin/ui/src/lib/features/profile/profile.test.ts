import { clearQuerySession } from "$lib/resources/query-client";
import { api } from "$lib/transport/api";
import { afterEach, expect, it, vi } from "vitest";

import { promiseResult } from "../../contracts/promise-result.js";
import { loadProfile, profile } from "./profile.svelte";

function deferred() {
  let resolve!: (value: { avatar: number | null }) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<{ avatar: number | null }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearQuerySession();
});

it("keeps the newest profile when earlier requests finish out of order", async () => {
  const first = deferred(),
    second = deferred();
  vi.spyOn(api, "get").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const old = loadProfile(),
    current = loadProfile();
  second.resolve({ avatar: 20 });
  await current;
  first.resolve({ avatar: 10 });
  await old;
  expect(profile.avatar).toBe(20);
  expect(profile.loaded).toBe(true);
});

it("does not clear a new profile when an obsolete read fails", async () => {
  const first = deferred(),
    second = deferred();
  vi.spyOn(api, "get").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const old = loadProfile();
  clearQuerySession();
  const current = loadProfile();
  second.resolve({ avatar: 20 });
  await current;
  first.reject(new Error("old request failed"));
  await old;
  expect(profile.avatar).toBe(20);
  expect(profile.loaded).toBe(true);
});

it("does not replace a saved avatar with a read started before that write", async () => {
  const pending = deferred();
  vi.spyOn(api, "get").mockReturnValueOnce(pending.promise);
  const read = loadProfile();
  profile.avatar = 30;
  pending.resolve({ avatar: 10 });
  await read;
  expect(profile.avatar).toBe(30);
});

it("discards a previous session profile even when the account logs in again", () => {
  return promiseResult(() => {
    profile.avatar = 30;
    clearQuerySession();
    expect(profile.avatar).toBeNull();
    expect(profile.loaded).toBe(false);
  });
});
