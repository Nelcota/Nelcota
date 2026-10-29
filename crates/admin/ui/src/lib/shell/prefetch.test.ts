import { afterEach, describe, expect, it, vi } from "vitest";

import { rememberSignedIn, wasSignedIn, watchSignOutElsewhere } from "./prefetch";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("signed-in hint", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is off for a browser that never signed in", () => {
    vi.stubGlobal("localStorage", storage());
    expect(wasSignedIn()).toBe(false);
  });

  it("follows the session: set once signed in, cleared on sign-out", () => {
    vi.stubGlobal("localStorage", storage());
    rememberSignedIn(true);
    expect(wasSignedIn()).toBe(true);
    rememberSignedIn(false);
    expect(wasSignedIn()).toBe(false);
  });

  it("is off, without throwing, when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(() => rememberSignedIn(true)).not.toThrow();
    expect(() => rememberSignedIn(false)).not.toThrow();
    expect(wasSignedIn()).toBe(false);
  });
});

describe("watchSignOutElsewhere", () => {
  afterEach(() => vi.unstubAllGlobals());

  const storageEvent = (key: string, newValue: string | null) =>
    Object.assign(new Event("storage"), { key, newValue });

  it("reports only another tab clearing the signed-in hint, until stopped", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const onSignedOut = vi.fn();
    const stop = watchSignOutElsewhere(onSignedOut);
    target.dispatchEvent(storageEvent("nelcota.signedIn", "1"));
    target.dispatchEvent(storageEvent("nelcota.locale", null));
    expect(onSignedOut).not.toHaveBeenCalled();
    target.dispatchEvent(storageEvent("nelcota.signedIn", null));
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    stop();
    target.dispatchEvent(storageEvent("nelcota.signedIn", null));
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });
});
