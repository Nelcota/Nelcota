import { onSessionEnded, session } from "$lib/resources/session.svelte";
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
