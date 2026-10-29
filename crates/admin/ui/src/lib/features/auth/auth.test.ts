import { profile } from "$lib/features/profile/profile.svelte";
import { clearQuerySession } from "$lib/resources/query-client";
import { session } from "$lib/resources/session.svelte";
import { api } from "$lib/transport/api";
import { afterEach, expect, it, vi } from "vitest";

import { logout } from "./auth";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearQuerySession();
});

it("does not clear a new session when a previous logout finishes late", async () => {
  session.email = "old@example.com";
  let finish!: (value: unknown) => void;
  vi.spyOn(api, "post").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = logout();
  clearQuerySession();
  session.email = "new@example.com";
  session.expired = false;
  profile.avatar = 42;
  finish({ ok: true });
  await pending;
  expect(session.email).toBe("new@example.com");
  expect(session.expired).toBe(false);
  expect(profile.avatar).toBe(42);
  expect(profile.loaded).toBe(true);
});

it("returns to the login screen when logout fails in the current session", async () => {
  session.email = "old@example.com";
  session.expired = true;
  profile.avatar = 42;
  vi.spyOn(api, "post").mockRejectedValue(new Error("network failed"));
  await logout();
  expect(session.email).toBeNull();
  expect(session.expired).toBe(false);
  expect(profile.avatar).toBeNull();
  expect(profile.loaded).toBe(false);
});

it("does not say the session expired when a read gets 401 during logout", async () => {
  session.email = "old@example.com";
  session.expired = false;
  let finish!: (value: unknown) => void;
  vi.spyOn(api, "post").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = logout();
  // What expireSession does when /profile answers 401 before /logout does.
  clearQuerySession();
  session.expired = true;
  session.email = null;
  finish({ ok: true });
  await pending;
  expect(session.email).toBeNull();
  expect(session.expired).toBe(false);
});
