import { afterEach, expect, it, vi } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { memoryStorage } from "../../src/index.js";
import { KEY, setup, stored } from "./auth-fixtures.js";
import { json, session } from "./http-fixtures.js";
import { WorkerScopeFixture } from "./worker-scope.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("refresh: refreshes a session about to expire before using it", async () => {
  const { nelcota, calls, events } = setup(
    stored(session(30)),
    json(session(900, "refresh-2", "access-2")),
    json([]),
  );
  await nelcota.from("notes").select().execute();
  expect(requiredValue(calls[0], "recorded test item").url.search).toBe(
    "?grant_type=refresh_token",
  );
  expect(
    JSON.parse(
      requiredValue(requiredValue(calls[0], "recorded test item").body, "request body"),
    ) as unknown,
  ).toEqual({ refresh_token: "refresh-1" });
  expect(requiredValue(calls[1], "recorded test item").headers.get("authorization")).toBe(
    "Bearer access-2",
  );
  expect(events).toEqual(["initial_session", "refreshed"]);
});

it("refresh: sends one refresh for many concurrent requests", async () => {
  const { nelcota, calls } = setup(stored(session(30)), (request) =>
    request.url.pathname === "/auth/v1/token"
      ? json(session(900, "refresh-2", "access-2"))
      : json([]),
  );
  await Promise.all([1, 2, 3, 4, 5].map(() => nelcota.from("notes").select().execute()));
  expect(calls.filter((c) => c.url.pathname === "/auth/v1/token")).toHaveLength(1);
  expect(calls.filter((c) => c.headers.get("authorization") === "Bearer access-2")).toHaveLength(5);
});

it("refresh: serializes refreshes across tabs: the second tab takes the first one's result", async () => {
  // A Web Lock shared by two clients with the same storage (two workers):
  // caller-supplied storage in a worker scope coordinates through Web Locks.
  vi.stubGlobal("WorkerGlobalScope", WorkerScopeFixture);
  let queue = Promise.resolve();
  const requested: string[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(name: string, task: () => Promise<T>) => {
        requested.push(name);
        const run = queue.then(task);
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    },
  });
  const storage = stored(session(30));
  let refreshes = 0;
  const reply = async (request: { url: URL }) => {
    const delayInMs = 20;

    if (request.url.pathname !== "/auth/v1/token") return json([]);
    refreshes++;
    await new Promise((r) => setTimeout(r, delayInMs));
    return json(session(900, "refresh-2", "access-2"));
  };
  const tabA = setup(storage, reply);
  const tabB = setup(storage, reply);
  const [a, b] = await Promise.all([
    tabA.nelcota.auth.getSession(),
    tabB.nelcota.auth.getSession(),
  ]);
  expect(refreshes).toBe(1);
  expect(a.data?.access_token).toBe("access-2");
  expect(b.data?.access_token).toBe("access-2");
  // The stub was the coordination, not the module-local queue.
  expect(requested).toContain(`${KEY}.refresh`);
});

it("refresh: keeps a still-valid token when a refresh within the margin fails transiently", async () => {
  const { nelcota, calls } = setup(stored(session(30)), (request) =>
    request.url.pathname === "/auth/v1/token"
      ? json({ code: "unavailable", message: "Busy" }, 503, { "retry-after": "5" })
      : json([]),
  );
  const first = await nelcota.from("notes").select().execute();
  expect(first.error).toBeNull();
  const second = await nelcota.from("notes").select().execute();
  expect(second.error).toBeNull();
  const tokens = calls.filter((call) => call.url.pathname === "/auth/v1/token");
  // Within Retry-After, a request does not try to rotate again.
  expect(tokens).toHaveLength(1);
  const reads = calls.filter((call) => call.url.pathname === "/rest/v1/notes");
  expect(reads.map((call) => call.headers.get("authorization"))).toEqual([
    "Bearer access-1",
    "Bearer access-1",
  ]);
  expect((await nelcota.auth.getSession()).data?.access_token).toBe("access-1");
});

it("refresh: a rejected refresh token signs out", async () => {
  const { nelcota, storage, events } = setup(
    stored(session(30)),
    json({ code: "invalid_grant", message: "refresh token reused; session ended" }, 400),
  );
  expect(await nelcota.auth.getSession()).toEqual({ data: null, error: null });
  expect(await storage.getItem(KEY)).toBeNull();
  expect(events).toEqual(["initial_session", "signed_out"]);
});

it("refresh: a transient refresh failure keeps the session and reaches the caller without an expired request", async () => {
  const { nelcota, calls, storage } = setup(stored(session(-5)), (request) => {
    if (request.url.pathname === "/auth/v1/token") throw new TypeError("fetch failed");
    return json({ code: "invalid_token", message: "expired" }, 401);
  });
  const { error } = await nelcota.from("notes").select().execute();
  expect(error?.status).toBe(0);
  expect(error?.code).toBe("network_error");
  expect(calls.every((call) => call.url.pathname === "/auth/v1/token")).toBe(true);
  expect(await storage.getItem(KEY)).not.toBeNull();
});

it("refresh: drops a corrupted stored session", async () => {
  const storage = memoryStorage();
  await storage.setItem(KEY, '{"access_token": 1}');
  const { nelcota } = setup(storage, json([]));
  expect((await nelcota.auth.getSession()).data).toBeNull();
  expect(await storage.getItem(KEY)).toBeNull();
});

it("refresh: a storage failure reaches data requests as a session_unavailable result", async () => {
  const storage = memoryStorage();
  const failed = new Error("storage unavailable");
  vi.spyOn(storage, "getItem").mockRejectedValue(failed);
  const { nelcota, calls } = setup(storage, json([]));
  const { error } = await nelcota.from("notes").select().execute();
  expect(error?.code).toBe("session_unavailable");
  expect(error?.cause).toBe(failed);
  expect(calls).toHaveLength(0);
});
