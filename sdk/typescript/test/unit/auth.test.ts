import { afterEach, expect, it, vi } from "vitest";

import { parseSession } from "../../src/auth/session.js";
import { requiredValue } from "../../src/core/required-value.js";
import { memoryStorage, type SessionStorage } from "../../src/index.js";
import { KEY, setup, stored } from "./auth-fixtures.js";
import { installWebLocks } from "./browser-environment.js";
import { gate as controlGate } from "./gate.js";
import { json, session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

for (const webLocks of [false, true]) {
  it.each(["signUp", "signInWithPassword", "verifyEmailLink", "resetPassword"] as const)(
    `queued authentication cancellation (Web Locks=${webLocks}) > cancels %s before the lifecycle owner finishes`,
    async (method) => {
      vi.useFakeTimers();
      installWebLocks(webLocks);

      const { promise: started, open: entered } = controlGate();
      const { promise: held, open: release } = controlGate();
      const { nelcota, calls } = setup(stored(session()), async () => {
        entered();
        await held;
        return json(session(900, "replacement"));
      });
      const rotating = nelcota.auth.refreshSession();
      await started;
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const actions = {
        signUp: () => nelcota.auth.signUp({ email: "a@example.com", password: "pw" }, options),
        signInWithPassword: () =>
          nelcota.auth.signInWithPassword({ email: "a@example.com", password: "pw" }, options),
        verifyEmailLink: () =>
          nelcota.auth.verifyEmailLink({ type: "signup", token: "fixture" }, options),
        resetPassword: () =>
          nelcota.auth.resetPassword({ token: "fixture", password: "pw" }, options),
      };
      let code: string | undefined;
      const pending = actions[method]().then((result) => {
        code = result.error?.code;
      });
      try {
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(code).toBe("aborted");
        expect(calls).toHaveLength(1);
      } finally {
        release();
        await Promise.all([rotating, pending]);
        expect(calls).toHaveLength(1);
        expect((await nelcota.auth.getSession()).data?.refresh_token).toBe("replacement");
        nelcota.dispose();
        vi.useRealTimers();
      }
    },
  );
}

it("finishes an accepted session publication after its sign-in waiter cancels", async () => {
  vi.useFakeTimers();

  const { promise: started, open: entered } = controlGate();
  const { promise: held, open: release } = controlGate();
  const backing = memoryStorage();
  const storage: SessionStorage = {
    ...backing,
    setItem: async (key, value) => {
      entered();
      await held;
      await backing.setItem(key, value);
    },
  };
  const { nelcota, calls } = setup(storage, json(session()));
  const controller = new AbortController();
  let code: string | undefined;
  const pending = nelcota.auth
    .signInWithPassword({ email: "a@example.com", password: "pw" }, { signal: controller.signal })
    .then((result) => {
      code = result.error?.code;
    });
  await started;
  try {
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(code).toBe("aborted");
    expect(await backing.getItem(KEY)).toBeNull();
  } finally {
    release();
    await pending;
    expect((await nelcota.auth.getSession()).data?.refresh_token).toBe("refresh-1");
    expect(
      requiredValue(
        parseSession(requiredValue(await backing.getItem(KEY), "required operation value")),
        "stored session",
      ).refresh_token,
    ).toBe("refresh-1");
    expect(calls).toHaveLength(1);
    nelcota.dispose();
    vi.useRealTimers();
  }
});
