import { afterEach, expect, it, vi } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { createClient } from "../../src/index.js";
import { KEY, browser, pkceBrowser } from "./browser-state-fixtures.js";
import { empty, json, mockFetch, session } from "./http-fixtures.js";

afterEach(() => vi.unstubAllGlobals());

it("exchanges OAuth with the committed verifier even when the native view is stale", async () => {
  const storage = pkceBrowser();
  const mock = mockFetch(json(session()));
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    await client.auth.signInWithOAuth({
      provider: "github",
      redirectTo: "https://app.example.com/auth",
      redirect: false,
    });
    const published: unknown = storage.setItem.mock.calls.find(
      ([key]) => key === `${KEY}.pkce`,
    )?.[1];
    await client.auth.exchangeCode("authorization-code");
    expect(JSON.parse(mock.calls[0]?.body ?? "null") as unknown).toMatchObject({
      code_verifier: published,
    });
  } finally {
    client.dispose();
  }
});

it("does not exchange an OAuth code twice from stale native verifier snapshots", async () => {
  pkceBrowser();
  const mock = mockFetch(json(session()), json(session()));
  const clients = [0, 1].map(() =>
    createClient("https://api.example.com", { fetch: mock.fetch, auth: { autoRefresh: false } }),
  );
  try {
    await requiredValue(clients[0], "recorded test item").auth.signInWithOAuth({
      provider: "github",
      redirectTo: "https://app.example.com/auth",
      redirect: false,
    });
    expect(
      (
        await requiredValue(clients[0], "recorded test item").auth.exchangeCode(
          "authorization-code",
        )
      ).error,
    ).toBeNull();
    expect(
      (
        await requiredValue(clients[1], "recorded test item").auth.exchangeCode(
          "authorization-code",
        )
      ).error?.code,
    ).toBe("pkce_missing");
    expect(mock.calls).toHaveLength(1);
  } finally {
    clients.forEach((client) => client.dispose());
  }
});

it("does not consume a pending OAuth verifier for an already cancelled exchange", async () => {
  const storage = pkceBrowser();
  const mock = mockFetch(json(session()));
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    await client.auth.signInWithOAuth({
      provider: "github",
      redirectTo: "https://app.example.com/auth",
      redirect: false,
    });
    expect(
      (await client.auth.exchangeCode("authorization-code", { signal: AbortSignal.abort() })).error
        ?.code,
    ).toBe("aborted");
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect((await client.auth.exchangeCode("authorization-code")).error).toBeNull();
    expect(mock.calls).toHaveLength(1);
  } finally {
    client.dispose();
  }
});

it("persists a claimed OAuth exchange after its caller cancels the wait", async () => {
  pkceBrowser();
  let started!: () => void;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = mockFetch(async () => {
    started();
    await response;
    return json(session(900, "accepted-oauth", "accepted-access"));
  });
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    await client.auth.signInWithOAuth({
      provider: "github",
      redirectTo: "https://app.example.com/auth",
      redirect: false,
    });
    const abort = new AbortController();
    const exchanged = client.auth.exchangeCode("authorization-code", { signal: abort.signal });
    await pending;
    abort.abort();
    expect((await exchanged).error?.code).toBe("aborted");
    release();
    expect((await client.auth.getSession()).data?.refresh_token).toBe("accepted-oauth");
    expect((await client.auth.exchangeCode("authorization-code")).error?.code).toBe("pkce_missing");
    expect(mock.calls).toHaveLength(1);
  } finally {
    release();
    client.dispose();
  }
});

it("hands the committed replacement to a queued tab with a stale native snapshot", async () => {
  browser();
  const mock = mockFetch(
    json(session(900, "replacement-1", "access-1")),
    json(session(900, "replacement-2", "access-2")),
  );
  const clients = [0, 1].map(() =>
    createClient("https://api.example.com", {
      fetch: mock.fetch,
      auth: { autoRefresh: false },
    }),
  );
  try {
    const values = await Promise.all(clients.map((client) => client.auth.getSession()));
    expect(mock.calls).toHaveLength(1);
    expect(values.map((value) => value.data?.refresh_token)).toEqual([
      "replacement-1",
      "replacement-1",
    ]);
  } finally {
    clients.forEach((client) => client.dispose());
  }
});

it("does not resurrect a signed-out session from a stale native mirror or a reopened client", async () => {
  browser();
  const mock = mockFetch(empty());
  const first = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  const other = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  try {
    await first.auth.setSession(session());
    expect((await other.auth.getSession()).data).not.toBeNull();
    await first.auth.signOut();
    first.dispose();
    expect((await other.auth.getSession()).data).toBeNull();
    expect((await other.auth.refreshSession()).error?.code).toBe("session_missing");
    expect(mock.calls).toHaveLength(1);
    const reopened = createClient("https://api.example.com", {
      fetch: mock.fetch,
      auth: { autoRefresh: false },
    });
    try {
      expect((await reopened.auth.getSession()).data).toBeNull();
    } finally {
      reopened.dispose();
    }
  } finally {
    first.dispose();
    other.dispose();
  }
});

it("keeps logout local when a foreign-owned receipt cannot be replaced", async () => {
  const { factory } = browser();
  const mock = mockFetch(() => {
    vi.spyOn(factory, "open").mockImplementationOnce(() => {
      throw new Error("logout commit failed");
    });
    return empty();
  });
  const clients = [0, 1].map(() =>
    createClient("https://api.example.com", { fetch: mock.fetch, auth: { autoRefresh: false } }),
  );
  try {
    await requiredValue(clients[0], "recorded test item").auth.setSession(session());
    await expect(requiredValue(clients[1], "recorded test item").auth.signOut()).rejects.toThrow(
      "logout commit failed",
    );
    expect(
      (await requiredValue(clients[1], "recorded test item").auth.getSession()).data,
    ).toBeNull();
    expect(mock.calls).toHaveLength(1);
  } finally {
    clients.forEach((client) => client.dispose());
  }
});
