import { afterEach, expect, it, vi } from "vitest";

import { parseSession } from "../../src/auth/session.js";
import { requiredValue } from "../../src/core/required-value.js";
import { memoryStorage } from "../../src/index.js";
import { KEY, setup, stored } from "./auth-fixtures.js";
import { empty, json, session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("sign-out and user: never reuses a spent refresh token after persistence fails", async () => {
  const storage = stored(session(30));
  const failed = new Error("storage unavailable");
  const setItem = vi.spyOn(storage, "setItem").mockRejectedValueOnce(failed);
  const { nelcota, calls } = setup(
    storage,
    json(session(900, "refresh-2", "access-2")),
    json(session(900, "refresh-3", "access-3")),
  );
  try {
    await expect(nelcota.auth.refreshSession()).rejects.toBe(failed);
    expect((await nelcota.auth.getSession()).data?.refresh_token).toBe("refresh-2");
    await nelcota.auth.refreshSession();
    expect(
      JSON.parse(
        requiredValue(requiredValue(calls[1], "recorded test item").body, "request body"),
      ) as unknown,
    ).toMatchObject({ refresh_token: "refresh-2" });
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(
      requiredValue(
        parseSession(requiredValue(await storage.getItem(KEY), "stored session")),
        "stored session",
      ).refresh_token,
    ).toBe("refresh-3");
  } finally {
    nelcota.dispose();
  }
});

it("sign-out and user: does not restore a revoked session after local deletion fails", async () => {
  const storage = stored(session());
  const failed = new Error("storage unavailable");
  vi.spyOn(storage, "removeItem").mockRejectedValueOnce(failed);
  const { nelcota, calls } = setup(storage, empty());
  try {
    await expect(nelcota.auth.signOut()).rejects.toBe(failed);
    expect((await nelcota.auth.getSession()).data).toBeNull();
    expect((await nelcota.auth.refreshSession()).error?.code).toBe("session_missing");
    await nelcota.auth.signOut();
    expect(calls).toHaveLength(1);
    expect(await storage.getItem(KEY)).toBeNull();
  } finally {
    nelcota.dispose();
  }
});

it("sign-out and user: updateUser sends snake_case fields and stores the returned user", async () => {
  const changed = { ...session().user, user_metadata: { plan: "pro" } };
  const { nelcota, calls, storage, events } = setup(stored(session()), json(changed));
  const result = await nelcota.auth.updateUser({
    password: "new-password-123",
    currentPassword: "old",
    data: { plan: "pro" },
  });
  expect(result.error).toBeNull();
  expect(requiredValue(calls[0], "recorded test item").method).toBe("PUT");
  expect(requiredValue(calls[0], "recorded test item").url.pathname).toBe("/auth/v1/user");
  expect(
    JSON.parse(
      requiredValue(requiredValue(calls[0], "recorded test item").body, "request body"),
    ) as unknown,
  ).toEqual({
    password: "new-password-123",
    current_password: "old",
    data: { plan: "pro" },
  });
  expect(
    requiredValue(
      parseSession(requiredValue(await storage.getItem(KEY), "stored session")),
      "stored session",
    ).user.user_metadata,
  ).toEqual({ plan: "pro" });
  expect(events).toEqual(["initial_session", "user_updated"]);
});

it("sign-out and user: updateUser without password or data is a usage error", async () => {
  const { nelcota, calls } = setup(stored(session()), empty());
  await expect(nelcota.auth.updateUser({ currentPassword: "x" })).rejects.toThrow(
    "password or data",
  );
  expect(calls).toHaveLength(0);
});

it("sign-out and user: does not restore a session when getUser completes after logout", async () => {
  let started!: () => void, finish!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const changed = { ...session().user, user_metadata: { name: "changed" } };
  const { nelcota, storage, events } = setup(stored(session()), async (request) => {
    if (request.url.pathname !== "/auth/v1/user") return empty();
    started();
    await wait;
    return json(changed);
  });
  const user = nelcota.auth.getUser();
  await begun;
  await nelcota.auth.signOut();
  finish();
  await user;
  expect((await nelcota.auth.getSession()).data).toBeNull();
  expect(await storage.getItem(KEY)).toBeNull();
  expect(events).toEqual(["initial_session", "signed_out"]);
});

it("sign-out and user: keeps rotated tokens when an old user response has the same access token", async () => {
  let started!: () => void, finish!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { nelcota, storage } = setup(stored(session()), async (request) => {
    if (request.url.pathname !== "/auth/v1/user")
      return json(session(900, "refresh-2", "access-1"));
    started();
    await wait;
    return json({ ...session().user, user_metadata: { stale: true } });
  });
  const user = nelcota.auth.getUser();
  await begun;
  await nelcota.auth.refreshSession();
  finish();
  await user;
  expect((await nelcota.auth.getSession()).data?.refresh_token).toBe("refresh-2");
  expect(
    requiredValue(
      parseSession(requiredValue(await storage.getItem(KEY), "stored session")),
      "stored session",
    ).user.user_metadata,
  ).toEqual({});
});

it("sign-out and user: does not overwrite a different sign-in with an old user response", async () => {
  let started!: () => void, finish!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const newer = {
    ...session(900, "refresh-2", "access-2"),
    user: { ...session().user, id: "u2" },
  };
  const { nelcota } = setup(stored(session()), async (request) => {
    if (request.url.pathname !== "/auth/v1/user") return json(newer);
    started();
    await wait;
    return json({ ...session().user, user_metadata: { stale: true } });
  });
  const user = nelcota.auth.getUser();
  await begun;
  await nelcota.auth.signInWithPassword({ email: "other@example.com", password: "pw" });
  finish();
  await user;
  expect((await nelcota.auth.getSession()).data).toEqual(newer);
});

it("sign-out and user: serializes logout after a pending password sign-in", async () => {
  let started!: () => void, finish!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { nelcota } = setup(memoryStorage(), async (request) => {
    if (request.url.pathname !== "/auth/v1/token") return empty();
    started();
    await wait;
    return json(session());
  });
  const signingIn = nelcota.auth.signInWithPassword({ email: "a@example.com", password: "pw" });
  await begun;
  const signingOut = nelcota.auth.signOut();
  finish();
  await Promise.all([signingIn, signingOut]);
  expect((await nelcota.auth.getSession()).data).toBeNull();
});

it("sign-out and user: revokes on the server and forgets locally even when the server fails", async () => {
  const ok = setup(stored(session()), empty(204));
  expect((await ok.nelcota.auth.signOut()).error).toBeNull();
  expect(requiredValue(ok.calls[0], "recorded test item").url.pathname).toBe("/auth/v1/logout");
  expect(requiredValue(ok.calls[0], "recorded test item").headers.get("authorization")).toBe(
    "Bearer access-1",
  );
  expect(await ok.storage.getItem(KEY)).toBeNull();
  expect(ok.events).toEqual(["initial_session", "signed_out"]);

  const down = setup(stored(session()), json({ code: "unavailable", message: "down" }, 503));
  expect((await down.nelcota.auth.signOut()).error?.code).toBe("unavailable");
  expect(await down.storage.getItem(KEY)).toBeNull();
});

it("sign-out and user: getUser updates the stored user", async () => {
  const changed = { ...session().user, email_confirmed_at: "2026-02-01T00:00:00Z" };
  const { nelcota, events, storage } = setup(stored(session()), json(changed));
  expect((await nelcota.auth.getUser()).data).toEqual(changed);
  expect(events).toEqual(["initial_session", "user_updated"]);
  expect(
    requiredValue(
      parseSession(requiredValue(await storage.getItem(KEY), "stored session")),
      "stored session",
    ).user.email_confirmed_at,
  ).toBe("2026-02-01T00:00:00Z");
  expect((await setup().nelcota.auth.getUser()).error?.code).toBe("session_missing");
});
