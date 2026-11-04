import type { TableData } from "$lib/contracts/types";
import { expect, it, vi, type Mocked } from "vitest";

import { promiseResult } from "../../../contracts/promise-result.js";
import { requiredValue } from "../../../contracts/required-value.js";
import { TableRows, type TableRowsAdapter } from "./table-rows.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function page(name: string, ids = ["1", "2"]): TableData {
  return {
    table: {
      name,
      kind: "table",
      comment: null,
      primary_key: ["id"],
      editable: true,
      insertable: true,
      exposed_without_rls: false,
      columns: [],
      rls: { state: "ok", label: "", enabled: true, forced: false, policies: 1 },
    },
    rows: ids.map((id) => ({ id, value: `old-${id}` })),
    page: 0,
    size: 25,
    has_next: false,
    total: ids.length,
    total_exact: true,
  };
}
function fixture() {
  const adapter: Mocked<TableRowsAdapter> = {
    read: vi.fn((table: string) => promiseResult(() => page(table))),
    update: vi.fn(() => promiseResult(() => ({ count: 1 }))),
    remove: vi.fn(() => promiseResult(() => ({ count: 1 }))),
  };
  return { adapter, rows: new TableRows(adapter) };
}

it("table row operations: clear forgets rows and selection, so a read as someone else never shows stale ones", async () => {
  const { rows } = fixture();
  await rows.load("docs", new URLSearchParams());
  rows.selected = new Set([0]);
  rows.clear();
  expect(rows.data).toBeNull();
  expect(rows.selected.size).toBe(0);
});

it("table row operations: reloads authoritative rows after an edit even when positions changed", async () => {
  const { rows, adapter } = fixture(),
    pending = deferred<{ count: number }>();
  adapter.update = vi.fn(() => pending.promise);
  await rows.load("docs", new URLSearchParams());
  const edit = rows.edit({ id: "1" }, "value", null);
  const data = requiredValue(rows.data, "response data");
  data.rows = data.rows.toReversed();
  const saved = page("docs", ["2", "1"]);
  saved.rows = [
    { id: "2", value: "old-2" },
    { id: "1", value: null },
  ];
  adapter.read.mockResolvedValueOnce(saved);
  pending.resolve({ count: 1 });
  expect(await edit).toBe(1);
  expect(requiredValue(rows.data, "response data").rows).toEqual([
    { id: "2", value: "old-2" },
    { id: "1", value: null },
  ]);
  expect(adapter.update).toHaveBeenCalledWith("docs", { id: "1" }, { value: null });
  expect(adapter.read).toHaveBeenCalledTimes(2);
});

it("table row operations: uses persisted normalization and derived values without mutating the old page", async () => {
  const { rows, adapter } = fixture();
  await rows.load("docs", new URLSearchParams());
  const before = rows.data;
  if (before === null) throw new Error("rows loaded");
  const saved = page("docs");
  saved.rows = [
    { id: "1", value: "old-1" },
    { id: "2", value: "1.24", computed: "2.48", updated_at: "new" },
  ];
  adapter.read.mockResolvedValueOnce(saved);
  expect(await rows.edit({ id: "2" }, "value", "1.239")).toBe(1);
  expect(rows.data).not.toBe(before);
  expect(before.rows).toEqual([
    { id: "1", value: "old-1" },
    { id: "2", value: "old-2" },
  ]);
  expect(rows.data?.rows).toEqual(saved.rows);
  expect(adapter.read).toHaveBeenCalledTimes(2);
  expect(adapter.update).toHaveBeenCalledWith("docs", { id: "2" }, { value: "1.239" });
});

it("table row operations: removes a stale row when the update matched nothing", async () => {
  const { rows, adapter } = fixture();
  adapter.update = vi.fn(() => promiseResult(() => ({ count: 0 })));
  await rows.load("docs", new URLSearchParams());
  adapter.read.mockResolvedValueOnce(page("docs", ["2"]));
  expect(await rows.edit({ id: "1" }, "value", "changed")).toBe(0);
  expect(rows.data?.rows).toEqual([{ id: "2", value: "old-2" }]);
  expect(rows.data?.total).toBe(1);
  expect(adapter.read).toHaveBeenCalledTimes(2);
});

it("table row operations: reconciles filters, ordering and totals after a successful edit", async () => {
  const { rows, adapter } = fixture();
  const params = new URLSearchParams({
    sort: "value",
    desc: "true",
    filters: JSON.stringify([{ column: "value", op: "neq", value: "hidden" }]),
  });
  await rows.load("docs", params);
  const saved = page("docs", ["2", "3"]);
  saved.total = 3;
  saved.has_next = true;
  adapter.read.mockResolvedValueOnce(saved);
  expect(await rows.edit({ id: "1" }, "value", "hidden")).toBe(1);
  expect(rows.data).toEqual(saved);
  expect(adapter.read).toHaveBeenLastCalledWith("docs", params, expect.any(AbortSignal));
});

it("table row operations: does not reload a cancelled page when its write finishes", async () => {
  const { rows, adapter } = fixture(),
    pending = deferred<{ count: number }>();
  adapter.update = vi.fn(() => pending.promise);
  await rows.load("docs", new URLSearchParams());
  const edit = rows.edit({ id: "1" }, "value", "changed");
  rows.cancel();
  pending.resolve({ count: 1 });
  expect(await edit).toBe(1);
  expect(adapter.read).toHaveBeenCalledTimes(1);
  expect(await rows.edit({ id: "2" }, "value", "cancelled")).toBeUndefined();
  expect(adapter.update).toHaveBeenCalledTimes(1);
  expect(rows.saving).toBe(false);
});

it("table row operations: reports reload failure without replaying a committed edit", async () => {
  const { rows, adapter } = fixture();
  await rows.load("docs", new URLSearchParams());
  const failure = new Error("read unavailable");
  adapter.read.mockRejectedValueOnce(failure);
  expect(await rows.edit({ id: "1" }, "value", "changed")).toBe(1);
  expect(rows.error).toBe(failure);
  expect(rows.saving).toBe(false);
  expect(adapter.update).toHaveBeenCalledTimes(1);
});

it("table row operations: does not mutate or reload another table when a write finishes after navigation", async () => {
  const { rows, adapter } = fixture(),
    pending = deferred<{ count: number }>();
  adapter.update = vi.fn(() => pending.promise);
  await rows.load("a", new URLSearchParams());
  const edit = rows.edit({ id: "1" }, "value", "changed");
  await rows.load("b", new URLSearchParams());
  pending.resolve({ count: 1 });
  await edit;
  expect(requiredValue(rows.data, "response data").table.name).toBe("b");
  expect(
    requiredValue(requiredValue(rows.data, "response data").rows[0], "test fixture item").value,
  ).toBe("old-1");
  expect(adapter.read).toHaveBeenCalledTimes(2);
  expect(rows.saving).toBe(false);
});

it("table row operations: refreshes the current page after a write on the same table completes", async () => {
  const { rows, adapter } = fixture(),
    pending = deferred<{ count: number }>();
  adapter.update = vi.fn(() => pending.promise);
  await rows.load("docs", new URLSearchParams("page=0"));
  const edit = rows.edit({ id: "1" }, "value", "changed");
  await rows.load("docs", new URLSearchParams("page=1"));
  pending.resolve({ count: 1 });
  await edit;
  expect(adapter.read).toHaveBeenCalledTimes(3);
  expect(
    requiredValue(vi.mocked(adapter.read).mock.calls[2], "test fixture item")[1].get("page"),
  ).toBe("1");
});

it("table row operations: captures selected primary keys before navigation during deletion", async () => {
  const { rows, adapter } = fixture(),
    pending = deferred<{ count: number }>();
  adapter.remove = vi.fn(() => pending.promise);
  await rows.load("a", new URLSearchParams());
  rows.selected = new Set([1]);
  const deletion = rows.deleteSelected();
  await rows.load("b", new URLSearchParams());
  pending.resolve({ count: 1 });
  expect(await deletion).toBe(1);
  expect(adapter.remove).toHaveBeenCalledWith("a", [{ id: "2" }]);
  expect(requiredValue(rows.data, "response data").table.name).toBe("b");
  expect(rows.selected.size).toBe(0);
  expect(adapter.read).toHaveBeenCalledTimes(2);
});

it("table row operations: blocks overlapping writes and releases saving state after failure", async () => {
  const { rows, adapter } = fixture(),
    pending = deferred<{ count: number }>();
  adapter.update = vi.fn(() => pending.promise);
  await rows.load("docs", new URLSearchParams());
  const edit = rows.edit({ id: "1" }, "value", "changed");
  expect(await rows.edit({ id: "2" }, "value", "other")).toBeUndefined();
  const failure = expect(edit).rejects.toThrow("offline");
  pending.reject(new Error("offline"));
  await failure;
  expect(rows.saving).toBe(false);
  expect(
    requiredValue(requiredValue(rows.data, "response data").rows[0], "test fixture item").value,
  ).toBe("old-1");
  expect(adapter.update).toHaveBeenCalledTimes(1);
});

it("table row operations: blocks edits while loading and ignores responses after cancellation", async () => {
  const { rows, adapter } = fixture(),
    pending = deferred<TableData>();
  await rows.load("docs", new URLSearchParams());
  adapter.read = vi.fn(() => pending.promise);
  const loading = rows.load("docs", new URLSearchParams("page=1"));
  expect(await rows.edit({ id: "1" }, "value", "changed")).toBeUndefined();
  rows.cancel();
  pending.resolve(page("docs", ["3"]));
  await loading;
  expect(
    requiredValue(requiredValue(rows.data, "response data").rows[0], "test fixture item").id,
  ).toBe("1");
  expect(adapter.update).not.toHaveBeenCalled();
});
