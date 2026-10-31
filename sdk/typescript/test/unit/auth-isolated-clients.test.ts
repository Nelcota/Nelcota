import { afterEach, expect, it, vi } from "vitest";

import { createClient } from "../../src/index.js";
import { installWebLocks } from "./browser-environment.js";
import { json, session } from "./http-fixtures.js";
import { promiseResult } from "./promise-result.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "isolated default server clients: keeps an independent cached session readable during another client sign-in (Web Locks=%s)",
  async (webLocks) => {
    const cancelDelayInMs = 1000;

    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    installWebLocks(webLocks);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createClient("https://api.example.com", {
      fetch: async () => {
        entered();
        await held;
        return json(session(900, "slow-refresh"));
      },
      auth: { autoRefresh: false },
    });
    const independent = createClient("https://api.example.com", {
      fetch: () => {
        return promiseResult(() => {
          throw new Error("A cached session read must not send HTTP");
        });
      },
      auth: { autoRefresh: false },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signing: Promise<unknown> | undefined;
    try {
      await independent.auth.setSession(session(900, "independent-refresh"));
      signing = slow.auth.signInWithPassword({ email: "ana@example.com", password: "pw" });
      await started;
      const cancel = new AbortController();
      timer = setTimeout(() => cancel.abort(), cancelDelayInMs);
      const result = await independent.auth.getSession({ signal: cancel.signal });
      expect(result.error).toBeNull();
      expect(result.data?.refresh_token).toBe("independent-refresh");
    } finally {
      clearTimeout(timer);
      release();
      await signing;
      slow.dispose();
      independent.dispose();
    }
  },
);
