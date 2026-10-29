import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { UpdatesConsoleState } from "./console-state.svelte";
import type { Status } from "./controller";

const status: Status = {
  email: "operator@example.test",
  projects: [{ name: "shop", version: "0.4.0", update_available: false }],
  jobs: [],
  release: null,
  enabled: false,
  checking: false,
  check_error: null,
};
function responseGate() {
  let complete: (response: Response) => void = () => {
    throw new Error("Response gate is not initialized");
  };
  const promise = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: (response: Response) => complete(response) };
}
beforeEach(() => {
  vi.useFakeTimers();
  const document = new EventTarget();
  Object.defineProperty(document, "hidden", { value: false });
  vi.stubGlobal("document", document);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("disposing the console aborts its request and discards a late status response", async () => {
  const pending = responseGate();
  const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise);
  vi.stubGlobal("fetch", fetch);
  const model = new UpdatesConsoleState();
  const completion = model.refresh();
  const dispose = model.mount();
  const signal = fetch.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  dispose();
  expect(signal?.aborted).toBe(true);
  pending.resolve(Response.json({ result: "status", data: status }));
  await completion;
  expect(vi.getTimerCount()).toBe(0);
  expect(model.status).toBeNull();
});
it("a pre-login response cannot replace the authenticated operator session", async () => {
  const old = responseGate();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValueOnce(Response.json({ result: "session", email: status.email }))
    .mockImplementation(() => Promise.resolve(Response.json({ result: "status", data: status })));
  vi.stubGlobal("fetch", fetch);
  const model = new UpdatesConsoleState();
  const stale = model.refresh();
  model.email = status.email;
  model.password = "test-operator-password";
  await model.login(new Event("submit", { cancelable: true }) as SubmitEvent);
  expect(model.status?.email).toBe(status.email);
  old.resolve(Response.json({ result: "error", code: "session_required" }, { status: 401 }));
  await stale;
  expect(model.status?.email).toBe(status.email);
  expect(model.signedOut).toBe(false);
  expect(model.password).toBe("");
  model.expire();
});
