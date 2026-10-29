import { afterEach, expect, it, vi } from "vitest";

import { BrowserSessionState } from "../../src/auth/browser/state.js";
import { requiredValue } from "../../src/core/required-value.js";
import { createClient } from "../../src/index.js";
import { KEY, browser } from "./browser-state-fixtures.js";
import { empty, json, mockFetch, session } from "./http-fixtures.js";

afterEach(() => vi.unstubAllGlobals());

it("retains an accepted sign-in when replacing a foreign receipt fails", async () => {
  const { factory } = browser();
  const replacement = session(900, "signed-in-replacement", "new-access");
  const mock = mockFetch(() => {
    vi.spyOn(factory, "open").mockImplementationOnce(() => {
      throw new Error("sign-in commit failed");
    });
    return json(replacement);
  });
  const clients = [0, 1].map(() =>
    createClient("https://api.example.com", { fetch: mock.fetch, auth: { autoRefresh: false } }),
  );
  try {
    await requiredValue(clients[0], "recorded test item").auth.setSession(session());
    await expect(
      requiredValue(clients[1], "recorded test item").auth.signInWithPassword({
        email: "ana@example.com",
        password: "example-password",
      }),
    ).rejects.toThrow("sign-in commit failed");
    expect(
      (await requiredValue(clients[1], "recorded test item").auth.getSession()).data?.refresh_token,
    ).toBe("signed-in-replacement");
    expect(mock.calls).toHaveLength(1);
  } finally {
    clients.forEach((client) => client.dispose());
  }
});

it("lets a newer foreign logout supersede an accepted sign-in whose write failed", async () => {
  const { factory } = browser();
  const mock = mockFetch(() => {
    vi.spyOn(factory, "open").mockImplementationOnce(() => {
      throw new Error("commit failed");
    });
    return json(session(900, "accepted", "accepted-access"));
  }, empty());
  const clients = [0, 1].map(() =>
    createClient("https://api.example.com", { fetch: mock.fetch, auth: { autoRefresh: false } }),
  );
  try {
    await requiredValue(clients[0], "recorded test item").auth.setSession(session());
    await expect(
      requiredValue(clients[1], "recorded test item").auth.signInWithPassword({
        email: "ana@example.com",
        password: "example-password",
      }),
    ).rejects.toThrow("commit failed");
    expect(
      (await requiredValue(clients[1], "recorded test item").auth.getSession()).data?.refresh_token,
    ).toBe("accepted");
    await requiredValue(clients[0], "recorded test item").auth.signOut();
    expect(
      (await requiredValue(clients[1], "recorded test item").auth.getSession()).data,
    ).toBeNull();
  } finally {
    clients.forEach((client) => client.dispose());
  }
});

it("detects a newer foreign commit even when it republishes the identical value", async () => {
  const { factory } = browser();
  const original = session();
  const mock = mockFetch(() => {
    vi.spyOn(factory, "open").mockImplementationOnce(() => {
      throw new Error("commit failed");
    });
    return empty();
  });
  const clients = [0, 1].map(() =>
    createClient("https://api.example.com", { fetch: mock.fetch, auth: { autoRefresh: false } }),
  );
  try {
    await requiredValue(clients[0], "recorded test item").auth.setSession(original);
    await expect(requiredValue(clients[1], "recorded test item").auth.signOut()).rejects.toThrow(
      "commit failed",
    );
    expect(
      (await requiredValue(clients[1], "recorded test item").auth.getSession()).data,
    ).toBeNull();
    // An explicit later session publication is a new decision, even if equal.
    await requiredValue(clients[0], "recorded test item").auth.setSession(original);
    expect(
      (await requiredValue(clients[1], "recorded test item").auth.getSession()).data?.refresh_token,
    ).toBe(original.refresh_token);
  } finally {
    clients.forEach((client) => client.dispose());
  }
});

it("retains an accepted sign-in over an unchanged foreign interrupted reservation", async () => {
  const { factory } = browser();
  const foreign = new BrowserSessionState(KEY, factory);
  const original = session(5);
  await foreign.read(() => JSON.stringify(original));
  await foreign.reserve(original);
  const mock = mockFetch(() => {
    vi.spyOn(factory, "open").mockImplementationOnce(() => {
      throw new Error("commit failed");
    });
    return json(session(900, "accepted", "accepted-access"));
  });
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    await expect(
      client.auth.signInWithPassword({ email: "ana@example.com", password: "example-password" }),
    ).rejects.toThrow("commit failed");
    expect((await client.auth.getSession()).data?.refresh_token).toBe("accepted");
    await foreign.write(null);
    expect((await client.auth.getSession()).data).toBeNull();
    expect(mock.calls).toHaveLength(1);
  } finally {
    client.dispose();
  }
});

it("upgrades the original receipt shape without losing its session", async () => {
  const { factory } = browser();
  const state = new BrowserSessionState(KEY, factory);
  await state.read(() => null);
  await new Promise<void>((resolve, reject) => {
    const request = factory.open("nelcota.auth", 1);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("sessions", "readwrite");
      transaction
        .objectStore("sessions")
        .put({ kind: "ready", owner: "previous-sdk", value: JSON.stringify(session()) }, KEY);
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
  const client = createClient("https://api.example.com", { auth: { autoRefresh: false } });
  try {
    expect((await client.auth.getSession()).data?.refresh_token).toBe("refresh-1");
  } finally {
    client.dispose();
  }
});

it("retains a received replacement and blocks another owner after its commit fails", async () => {
  const { factory } = browser();
  const failed = new Error("IndexedDB write failed");
  const replacement = session(900, "replacement", "access-new");
  const mock = mockFetch(() => {
    vi.spyOn(factory, "open").mockImplementationOnce(() => {
      throw failed;
    });
    return json(replacement);
  });
  const first = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  const other = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    await expect(first.auth.getSession()).rejects.toBe(failed);
    expect((await first.auth.getSession()).data?.refresh_token).toBe("replacement");
    await expect(other.auth.getSession()).rejects.toThrow("interrupted");
    expect(mock.calls).toHaveLength(1);
    await first.auth.setSession(replacement);
    expect((await other.auth.getSession()).data?.refresh_token).toBe("replacement");
    expect(mock.calls).toHaveLength(1);
  } finally {
    first.dispose();
    other.dispose();
  }
});

it("lets another tab sign out an interrupted refresh and supersedes the dirty owner", async () => {
  const { factory } = browser();
  const mock = mockFetch(() => {
    vi.spyOn(factory, "open").mockImplementationOnce(() => {
      throw new Error("commit failed");
    });
    return json(session(900, "replacement", "new-access"));
  }, empty());
  const clients = [0, 1].map(() =>
    createClient("https://api.example.com", { fetch: mock.fetch, auth: { autoRefresh: false } }),
  );
  try {
    await expect(requiredValue(clients[0], "recorded test item").auth.getSession()).rejects.toThrow(
      "commit failed",
    );
    await requiredValue(clients[1], "recorded test item").auth.signOut();
    expect(
      (await requiredValue(clients[0], "recorded test item").auth.getSession()).data,
    ).toBeNull();
    expect(
      (await requiredValue(clients[1], "recorded test item").auth.getSession()).data,
    ).toBeNull();
    expect(mock.calls.map((call) => call.url.pathname)).toEqual([
      "/auth/v1/token",
      "/auth/v1/logout",
    ]);
  } finally {
    clients.forEach((client) => client.dispose());
  }
});
