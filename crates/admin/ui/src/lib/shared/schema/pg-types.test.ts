import { clearQuerySession } from "$lib/resources/query-client";
import { afterEach, expect, it, vi } from "vitest";

import { ddl } from "./ddl";
import { loadTypes, pgTypes } from "./pg-types.svelte";

function deferred() {
  let resolve!: (value: { base: string[]; enums: string[] }) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<{ base: string[]; enums: string[] }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearQuerySession();
});

it("loads fresh types after a new session and hides the old catalog immediately", async () => {
  vi.spyOn(ddl, "types").mockResolvedValueOnce({ base: ["text"], enums: ["old_status"] });
  await loadTypes();
  clearQuerySession();
  expect(pgTypes.loaded).toBe(false);
  expect(pgTypes.enums).toEqual([]);
  vi.mocked(ddl.types).mockResolvedValueOnce({ base: ["uuid"], enums: ["new_status"] });
  await loadTypes();
  expect(pgTypes.enums).toEqual(["new_status"]);
  expect(pgTypes.base).toEqual(["uuid"]);
});

it("keeps an older response from replacing the current session types", async () => {
  const first = deferred(),
    second = deferred();
  vi.spyOn(ddl, "types").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const old = loadTypes();
  clearQuerySession();
  const current = loadTypes();
  second.resolve({ base: ["text"], enums: ["current"] });
  await current;
  first.resolve({ base: ["text"], enums: ["obsolete"] });
  await old;
  expect(pgTypes.enums).toEqual(["current"]);
});

it("an obsolete failure cannot clear the new session pending request", async () => {
  const first = deferred(),
    second = deferred();
  const types = vi
    .spyOn(ddl, "types")
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const old = loadTypes();
  clearQuerySession();
  const current = loadTypes();
  first.reject(new Error("old request failed"));
  await old;
  const shared = loadTypes();
  expect(shared).toBe(current);
  expect(types).toHaveBeenCalledTimes(2);
  second.resolve({ base: ["text"], enums: [] });
  await current;
});

it("shares pending reads and permits retry after a current failure", async () => {
  const pending = deferred();
  const types = vi.spyOn(ddl, "types").mockReturnValueOnce(pending.promise);
  const first = loadTypes(),
    second = loadTypes();
  expect(first).toBe(second);
  pending.reject(new Error("offline"));
  await first;
  types.mockResolvedValueOnce({ base: ["text"], enums: ["retried"] });
  await loadTypes();
  expect(types).toHaveBeenCalledTimes(2);
  expect(pgTypes.enums).toEqual(["retried"]);
});
