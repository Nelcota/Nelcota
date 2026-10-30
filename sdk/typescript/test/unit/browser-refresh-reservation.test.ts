import { afterEach, expect, it, vi } from "vitest";

import { BrowserSessionConflictError } from "../../src/auth/browser/session.errors.js";
import { BrowserSessionState } from "../../src/auth/browser/state.js";
import { requiredValue } from "../../src/core/required-value.js";
import { createClient } from "../../src/index.js";
import { KEY, browser } from "./browser-state-fixtures.js";
import { json, mockFetch, session } from "./http-fixtures.js";

afterEach(() => vi.unstubAllGlobals());

it("does not send a refresh when the reservation cannot commit", async () => {
  const { factory } = browser();
  const mock = mockFetch(json(session()));
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    // Seed a fresh session, then fail the transaction that reserves rotation.
    await client.auth.setSession(session());
    // oxlint-disable-next-line typescript/unbound-method -- Instrumentation explicitly invokes this saved method with .call(this).
    const original = BrowserSessionState.prototype.reserve;
    const reservation = vi
      .spyOn(BrowserSessionState.prototype, "reserve")
      .mockImplementation(function (this: BrowserSessionState, value) {
        vi.spyOn(factory, "open").mockImplementationOnce(() => {
          throw new Error("reservation failed");
        });
        return original.call(this, value);
      });
    try {
      const { error } = await client.auth.refreshSession();
      expect(error?.code).toBe("session_unavailable");
      expect(error?.cause).toEqual(new Error("reservation failed"));
      expect(mock.calls).toHaveLength(0);
    } finally {
      reservation.mockRestore();
    }
  } finally {
    client.dispose();
  }
});

it("keeps different API namespaces isolated in the shared database", async () => {
  browser();
  const clients = ["/one", "/two"].map((path) =>
    createClient(`https://api.example.com${path}`, { auth: { autoRefresh: false } }),
  );
  try {
    await requiredValue(clients[0], "recorded test item").auth.setSession(
      session(900, "one", "one-access"),
    );
    await requiredValue(clients[1], "recorded test item").auth.setSession(
      session(900, "two", "two-access"),
    );
    expect(
      (await requiredValue(clients[0], "recorded test item").auth.getSession()).data?.refresh_token,
    ).toBe("one");
    expect(
      (await requiredValue(clients[1], "recorded test item").auth.getSession()).data?.refresh_token,
    ).toBe("two");
  } finally {
    clients.forEach((client) => client.dispose());
  }
});

it("rejects a late refresh completion after another owner signed out", async () => {
  const { factory } = browser();
  const first = new BrowserSessionState(KEY, factory);
  const second = new BrowserSessionState(KEY, factory);
  const original = session(5);
  await first.read(() => JSON.stringify(original));
  await first.reserve(original);
  await second.write(null);
  await expect(first.write(JSON.stringify(session()), true)).rejects.toThrow(
    "changed during refresh",
  );
  expect((await first.read(() => JSON.stringify(original))).value).toBeNull();
});

it("does not emit a replacement session when a late response conflicts with logout", async () => {
  const { factory } = browser();
  let started!: () => void;
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const response = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const mock = mockFetch(async () => {
    started();
    await response;
    return json(session(900, "late-replacement", "new-access"));
  });
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  const events: unknown[] = [];
  client.auth.onChange((event, value) => {
    events.push({ event, value });
  });
  try {
    const refresh = client.auth.getSession();
    await pending;
    // An independent owner without a shared Web Lock can commit logout.
    await new BrowserSessionState(KEY, factory).write(null);
    complete();
    const { error } = await refresh;
    expect(error?.code).toBe("session_unavailable");
    expect(error?.cause).toBeInstanceOf(BrowserSessionConflictError);
    expect(events).toEqual([
      {
        event: "initial_session",
        value: expect.objectContaining({ refresh_token: "refresh-1" }) as unknown,
      },
      { event: "signed_out", value: null },
    ]);
    expect((await client.auth.getSession()).data).toBeNull();
  } finally {
    complete();
    client.dispose();
  }
});

it("can reuse the original session on the same owner after an uncertain network outcome", async () => {
  browser();
  const mock = mockFetch(
    json({ code: "gateway_error", message: "unknown outcome" }, 503),
    json(session(900, "replacement", "new-access")),
  );
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    // The 503 is transient and the access token is still valid: keep using it.
    const kept = await client.auth.getSession();
    expect(kept.error).toBeNull();
    expect(kept.data?.refresh_token).toBe("refresh-1");
    expect((await client.auth.refreshSession()).data?.refresh_token).toBe("replacement");
    expect(mock.calls).toHaveLength(2);
  } finally {
    client.dispose();
  }
});

it("rejects malformed receipts and closes storage connections for deletion", async () => {
  const { factory } = browser();
  const state = new BrowserSessionState(KEY, factory);
  await state.read(() => JSON.stringify(session()));
  await new Promise<void>((resolve, reject) => {
    const request = factory.open("nelcota.auth", 1);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("sessions", "readwrite");
      transaction.objectStore("sessions").put({ kind: "ready", owner: 123, value: "bad" }, KEY);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error("Fixture transaction aborted without a reason"));
      };
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Fixture database request failed without a reason"));
  });
  await expect(state.read(() => JSON.stringify(session()))).rejects.toThrow(
    "Invalid browser session receipt",
  );
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase("nelcota.auth");
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Fixture database request failed without a reason"));
    request.onblocked = () => reject(new Error("Leaked browser session connection"));
  });
});

it("reports an unavailable or blocked database without sending auth requests", async () => {
  const { factory } = browser();
  await expect(
    new BrowserSessionState(KEY, undefined).read(() => JSON.stringify(session())),
  ).rejects.toThrow("IndexedDB is required");
  const blocked = {} as IDBOpenDBRequest;
  vi.spyOn(factory, "open").mockImplementationOnce(() => {
    setTimeout(() => {
      blocked.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
    }, 0);
    return blocked;
  });
  await expect(
    new BrowserSessionState(KEY, factory).read(() => JSON.stringify(session())),
  ).rejects.toThrow("storage is blocked");
});

it("closes the database when starting a storage request throws synchronously", async () => {
  const { factory } = browser();
  // IndexedDB rejects NaN keys synchronously rather than firing request.onerror.
  const state = new BrowserSessionState(Number.NaN as unknown as string, factory);
  await expect(state.read(() => JSON.stringify(session()))).rejects.toThrow();
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase("nelcota.auth");
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Fixture database request failed without a reason"));
    request.onblocked = () => reject(new Error("Leaked browser session connection"));
  });
});
