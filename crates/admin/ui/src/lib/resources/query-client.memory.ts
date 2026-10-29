import { afterEach, expect, it } from "vitest";

import { promiseResult } from "../contracts/promise-result.js";
import { requiredValue } from "../contracts/required-value.js";
import { clearQuerySession, queryRead } from "./query-client";

afterEach(clearQuerySession);

const collect = requiredValue(
  (globalThis as { gc?: () => void }).gc,
  "explicit garbage collection",
);
it("releases cancelled readers while another reader still waits", async () => {
  let finish!: (value: string) => void;
  const active = queryRead(
    { path: "/retention", account: "admin" },
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  async function cancel() {
    const controller = new AbortController();
    const reference = new WeakRef(controller.signal);
    const pending = queryRead(
      { path: "/retention", account: "admin" },
      () => promiseResult(() => "unexpected"),
      { signal: controller.signal },
    );
    controller.abort();
    // Vitest retains async assertion failures and their native stack frames
    // until the test finishes. Do not let the test harness own these signals.
    await pending.then(
      () => {
        throw new Error("Reader ignored cancellation");
      },
      (error) => {
        if (error instanceof DOMException === false || error.name !== "AbortError") throw error;
      },
    );
    return reference;
  }
  try {
    const references = [];
    // oxlint-disable-next-line no-await-in-loop -- Settle each cancellation and GC turn before measuring the next retained-reference sample.
    for (let index = 0; index < 1000; index++) references.push(await cancel());
    for (let index = 0; index < 10; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Settle each cancellation and GC turn before measuring the next retained-reference sample.
      await new Promise((resolve) => setTimeout(resolve, 0));
      collect();
    }
    expect(references.filter((reference) => reference.deref() !== undefined)).toHaveLength(0);
  } finally {
    finish("accepted");
    expect(await active).toBe("accepted");
  }
});
