import type { StorageListing } from "$lib/contracts/types";
import { expect, it, vi, type Mocked } from "vitest";

import { promiseResult } from "../../contracts/promise-result.js";
import { requiredValue } from "../../contracts/required-value.js";
import { BULK_DELETE_BATCH, StorageBrowser, type StorageBrowserAdapter } from "./browser.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function listing(name: string, more = false): StorageListing {
  return {
    folders: [],
    has_next: more,
    objects: [
      { id: name, name, size: 1, mime_type: "text/plain", owner: null, updated_at: "2026-10-08" },
    ],
  };
}
function fixture() {
  const adapter: Mocked<StorageBrowserAdapter> = {
    info: vi.fn(() => promiseResult(() => null)),
    list: vi.fn<StorageBrowserAdapter["list"]>((target) =>
      promiseResult(() => listing(target.prefix + "first.txt", true)),
    ),
    remove: vi.fn(() => promiseResult(() => undefined)),
    removeMany: vi.fn((_bucket: string, names: string[]) => promiseResult(() => names.length)),
    upload: vi.fn(() => promiseResult(() => undefined)),
    isConflict: vi.fn<StorageBrowserAdapter["isConflict"]>((error) => error === "exists"),
  };
  return { adapter, browser: new StorageBrowser(adapter) };
}

it("storage browser operations: advances through folder-only pages and retains earlier folders", async () => {
  const { browser, adapter } = fixture();
  adapter.list = vi
    .fn()
    .mockResolvedValueOnce({ folders: ["a", "b"], objects: [], has_next: true })
    .mockResolvedValueOnce({ folders: ["c"], objects: [], has_next: false });
  await browser.open({ bucket: "docs", prefix: "" });
  await browser.load(true);
  expect(requiredValue(vi.mocked(adapter.list).mock.calls[1], "test fixture item")[1]).toBe(2);
  expect(requiredValue(browser.filesResource.data, "response data").folders).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(requiredValue(browser.filesResource.data, "response data").has_next).toBe(false);
});

it("storage browser operations: paginates the captured folder and blocks duplicate page requests", async () => {
  const { browser, adapter } = fixture(),
    page = deferred<StorageListing>();
  await browser.open({ bucket: "docs", prefix: "old/" });
  adapter.list = vi.fn(() => page.promise);
  const more = browser.load(true);
  expect(await browser.load(true)).toBe(false);
  expect(adapter.list).toHaveBeenCalledTimes(1);
  expect(
    requiredValue(vi.mocked(adapter.list).mock.calls[0], "test fixture item").slice(0, 2),
  ).toEqual([{ bucket: "docs", prefix: "old/" }, 1]);
  page.resolve(listing("old/second.txt"));
  await more;
  expect(
    requiredValue(browser.filesResource.data, "response data").objects.map((item) => item.name),
  ).toEqual(["old/first.txt", "old/second.txt"]);
});

it("storage browser operations: ignores a stale folder page after navigation", async () => {
  const { browser, adapter } = fixture(),
    old = deferred<StorageListing>();
  await browser.open({ bucket: "docs", prefix: "old/" });
  adapter.list = vi
    .fn()
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValue(listing("new/first.txt"));
  const more = browser.load(true);
  await browser.open({ bucket: "docs", prefix: "new/" });
  old.resolve(listing("old/second.txt"));
  expect(await more).toBe(false);
  expect(
    requiredValue(
      requiredValue(browser.filesResource.data, "response data").objects[0],
      "test fixture item",
    ).name,
  ).toBe("new/first.txt");
  expect(adapter.info).toHaveBeenCalledTimes(1);
});

it("storage browser operations: does not reload a different bucket when deletion completes", async () => {
  const { browser, adapter } = fixture(),
    removal = deferred<unknown>();
  await browser.open({ bucket: "a", prefix: "" });
  adapter.remove = vi.fn(() => removal.promise);
  const deleting = browser.remove("first.txt");
  await browser.open({ bucket: "b", prefix: "" });
  removal.resolve(undefined);
  await deleting;
  expect(adapter.remove).toHaveBeenCalledWith("a", "first.txt");
  expect(adapter.list).toHaveBeenCalledTimes(2);
  expect(adapter.info).toHaveBeenCalledTimes(2);
});

it("storage browser operations: refreshes objects and bucket metadata after a deletion in the current folder", async () => {
  const { browser, adapter } = fixture();
  await browser.open({ bucket: "docs", prefix: "folder/" });
  await browser.remove("folder/first.txt");
  expect(adapter.list).toHaveBeenCalledTimes(2);
  expect(adapter.info).toHaveBeenCalledTimes(2);
});

it("storage browser operations: keeps the loaded pages after a deletion or an upload", async () => {
  const { browser, adapter } = fixture();
  adapter.list = vi.fn((_target, offset: number) =>
    promiseResult(() => listing(`file-${offset}.txt`, offset < 2)),
  );
  await browser.open({ bucket: "docs", prefix: "" });
  await browser.load(true);
  await browser.load(true);
  expect(requiredValue(browser.filesResource.data, "response data").objects).toHaveLength(3);
  vi.mocked(adapter.list).mockClear();
  await browser.remove("file-1.txt");
  expect(vi.mocked(adapter.list).mock.calls.map((call) => call[1])).toEqual([0, 1, 2]);
  expect(requiredValue(browser.filesResource.data, "response data").objects).toHaveLength(3);
  vi.mocked(adapter.list).mockClear();
  await browser.send([new File(["x"], "new.txt")]);
  expect(vi.mocked(adapter.list).mock.calls.map((call) => call[1])).toEqual([0, 1, 2]);
});

it("storage browser operations: deletes many files in batches and reloads even when a batch fails", async () => {
  const { browser, adapter } = fixture();
  await browser.open({ bucket: "docs", prefix: "" });
  const names = Array.from({ length: BULK_DELETE_BATCH * 2 + 1 }, (_, i) => `f${i}`);
  expect(await browser.removeMany(names)).toBe(names.length);
  expect(
    vi.mocked(adapter.removeMany).mock.calls.map(([bucket, batch]) => [bucket, batch.length]),
  ).toEqual([
    ["docs", BULK_DELETE_BATCH],
    ["docs", BULK_DELETE_BATCH],
    ["docs", 1],
  ]);
  expect(adapter.list).toHaveBeenCalledTimes(2);

  adapter.removeMany = vi
    .fn()
    .mockResolvedValueOnce(BULK_DELETE_BATCH)
    .mockRejectedValueOnce(new Error("offline"));
  await expect(browser.removeMany(names)).rejects.toThrow("offline");
  expect(adapter.removeMany).toHaveBeenCalledTimes(2);
  expect(adapter.list).toHaveBeenCalledTimes(3);
});

it("storage browser operations: retains upload conflicts and their destination after navigation", async () => {
  const { browser, adapter } = fixture(),
    uploading = deferred<unknown>();
  const file = new File(["x"], "existing.txt");
  await browser.open({ bucket: "docs", prefix: "old/" });
  adapter.upload = vi.fn(() => uploading.promise);
  const sent = browser.send([file]);
  await browser.open({ bucket: "other", prefix: "new/" });
  const reads = vi.mocked(adapter.list).mock.calls.length;
  uploading.reject("exists");
  const result = await sent;
  expect(requiredValue(result, "operation result").conflicts).toEqual([file]);
  expect(requiredValue(result, "operation result").target).toEqual({
    bucket: "docs",
    prefix: "old/",
  });
  expect(adapter.list).toHaveBeenCalledTimes(reads);
  expect(browser.uploads.progress).toBeNull();
});

it("storage browser operations: discards cancelled reads and propagates mutation failure without refreshing", async () => {
  const { browser, adapter } = fixture(),
    page = deferred<StorageListing>();
  await browser.open({ bucket: "docs", prefix: "" });
  adapter.remove = vi.fn(() => {
    return promiseResult(() => {
      throw new Error("offline");
    });
  });
  await expect(browser.remove("first.txt")).rejects.toThrow("offline");
  expect(adapter.list).toHaveBeenCalledTimes(1);
  adapter.list = vi.fn(() => page.promise);
  const reading = browser.load();
  const signal = requiredValue(vi.mocked(adapter.list).mock.calls[0], "test fixture item")[2];
  browser.cancel();
  expect(signal.aborted).toBe(true);
  page.resolve(listing("stale.txt"));
  expect(await reading).toBe(false);
  expect(
    requiredValue(
      requiredValue(browser.filesResource.data, "response data").objects[0],
      "test fixture item",
    ).name,
  ).toBe("first.txt");
});
