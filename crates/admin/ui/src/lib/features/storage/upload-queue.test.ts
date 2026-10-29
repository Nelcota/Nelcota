import { expect, it } from "vitest";

import { promiseResult } from "../../contracts/promise-result.js";
import { requiredValue } from "../../contracts/required-value.js";
import { UploadQueue } from "./upload-queue.svelte";

it("captures the target, reports partial success, and retries conflicts at the original destination", async () => {
  const calls: { target: string; name: string; replace: boolean }[] = [];
  const target = { bucket: "documents", prefix: "old/" };
  const queue = new UploadQueue(
    (file, destination, { replace, progress }) => {
      return promiseResult(() => {
        calls.push({
          target: destination.bucket + "/" + destination.prefix,
          name: file.name,
          replace,
        });
        target.prefix = "navigated/";
        progress(2, file.size);
        if (file.name === "exists.txt" && Boolean(replace) === false) throw new Error("conflict");
        if (file.name === "failed.txt") throw new Error("offline");
      });
    },
    (error) => error instanceof Error && error.message === "conflict",
  );
  const result = await queue.send(
    ["ok.txt", "exists.txt", "failed.txt"].map((name) => new File(["text"], name)),
    target,
  );
  expect(result?.sent).toBe(1);
  expect(result?.errors).toHaveLength(1);
  expect(queue.items.map((item) => item.status)).toEqual(["done", "conflict", "error"]);
  expect(calls.every((call) => call.target === "documents/old/")).toBe(true);
  expect(queue.progress).toBeNull();
  await queue.send(
    requiredValue(result, "operation result").conflicts,
    requiredValue(result, "operation result").target,
    true,
  );
  expect(calls.at(-1)).toEqual({ target: "documents/old/", name: "exists.txt", replace: true });
});

it("prevents simultaneous sends and clearing a live queue", async () => {
  let finish!: () => void;
  const queue = new UploadQueue(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    () => false,
  );
  const file = new File(["text"], "one.txt");
  const running = queue.send([file], { bucket: "docs", prefix: "" });
  expect(await queue.send([file], { bucket: "other", prefix: "" })).toBeUndefined();
  queue.clear();
  expect(queue.items).toHaveLength(1);
  finish();
  await running;
  queue.clear();
  expect(queue.items).toHaveLength(0);
});
