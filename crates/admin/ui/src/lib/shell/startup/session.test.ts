import { onSessionEnded, session } from "$lib/resources/session.svelte";
import { ApiError } from "$lib/transport/api";
import { afterEach, expect, it, vi } from "vitest";

import { StartupSession } from "./session.svelte";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

/** Watches for another tab's sign-out on a stub window; returns it. */
function watchOtherTabs(ended: () => void): EventTarget {
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  cleanups.push(onSessionEnded(ended), new StartupSession().watch());
  return target;
}

const signedOutElsewhere = () =>
  Object.assign(new Event("storage"), { key: "nelcota.signedIn", newValue: null });

it("runs the session-ended cleanups when another tab signs out", () => {
  session.email = "admin@example.com";
  session.expired = true;
  const ended = vi.fn();
  watchOtherTabs(ended).dispatchEvent(signedOutElsewhere());
  expect(session.email).toBeNull();
  expect(session.expired).toBe(false);
  expect(ended).toHaveBeenCalledOnce();
});

it("ignores another tab's sign-out once this one is signed out", () => {
  session.email = null;
  const ended = vi.fn();
  watchOtherTabs(ended).dispatchEvent(signedOutElsewhere());
  expect(ended).not.toHaveBeenCalled();
});

/** A localStorage stand-in holding `entries`; `values` shows what is left. */
function storage(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

const HTTP_UNAUTHORIZED = 401;
const unauthorized = () => Promise.reject(new ApiError("unauthorized", HTTP_UNAUTHORIZED));
const work = {
  "nelcota:sql-history": JSON.stringify(["alter role app password 'secret'"]),
  "nelcota:sql-workspace": JSON.stringify({ v: 1, active: "a", items: [] }),
  "nelcota:sql-saved": JSON.stringify({ v: 1, items: [] }),
};

it("forgets SQL history and drafts left by a session that ended while no tab was open", async () => {
  const stored = storage({ ...work, "nelcota.signedIn": "1" });
  vi.stubGlobal("localStorage", stored);
  session.email = undefined;
  const ended = vi.fn();
  cleanups.push(onSessionEnded(ended));
  await new StartupSession().check(unauthorized());
  expect(session.email).toBeNull();
  expect(ended).toHaveBeenCalledOnce();
  expect([...stored.values.keys()].toSorted()).toEqual(["nelcota.signedIn", "nelcota:sql-saved"]);
});

it("keeps the stored work when this browser was not signed in", async () => {
  const stored = storage(work);
  vi.stubGlobal("localStorage", stored);
  const ended = vi.fn();
  cleanups.push(onSessionEnded(ended));
  await new StartupSession().check(unauthorized());
  expect(ended).not.toHaveBeenCalled();
  expect(stored.values.has("nelcota:sql-history")).toBe(true);
});

it("does not end a session again when nothing was left behind", async () => {
  vi.stubGlobal("localStorage", storage({ "nelcota.signedIn": "1" }));
  const ended = vi.fn();
  cleanups.push(onSessionEnded(ended));
  await new StartupSession().check(unauthorized());
  expect(ended).not.toHaveBeenCalled();
  expect(session.email).toBeNull();
});
