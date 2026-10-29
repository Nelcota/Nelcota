import { afterEach, expect, it, vi } from "vitest";

import { parseSession } from "../../src/auth/session.js";
import { requiredValue } from "../../src/core/required-value.js";
import { memoryStorage } from "../../src/index.js";
import { KEY, setup } from "./auth-fixtures.js";
import { json, session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("password sign-in: persists a pending sign-in after disposal without broadcasting on a closed channel", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  let finish!: (response: Response) => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { nelcota, storage } = setup(memoryStorage(), async () => {
    started();
    return await response;
  });
  const pending = nelcota.auth.signInWithPassword({ email: "a@x.com", password: "pw" });
  await begun;
  nelcota.dispose();
  nelcota.dispose();
  finish(json(session()));
  expect((await pending).error).toBeNull();
  expect(
    requiredValue(
      parseSession(requiredValue(await storage.getItem(KEY), "stored session")),
      "stored session",
    ).refresh_token,
  ).toBe("refresh-1");
});

it("password sign-in: accepts cancellation options without sending an aborted sign-in", async () => {
  const { nelcota, calls } = setup();
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await nelcota.auth.signInWithPassword(
        { email: "a@x.com", password: "pw" },
        { signal: controller.signal },
      )
    ).error?.code,
  ).toBe("aborted");
  expect(calls).toHaveLength(0);
});

it("password sign-in: stores the session, emits signed_in and uses the token", async () => {
  const { nelcota, calls, storage, events } = setup(memoryStorage(), json(session()), json([]));
  const { data, error } = await nelcota.auth.signInWithPassword({
    email: " ana@example.com ",
    password: "pw",
  });
  expect(error).toBeNull();
  expect(data?.access_token).toBe("access-1");
  expect(requiredValue(calls[0], "recorded test item").url.search).toBe("?grant_type=password");
  expect(
    JSON.parse(
      requiredValue(requiredValue(calls[0], "recorded test item").body, "request body"),
    ) as unknown,
  ).toEqual({ email: "ana@example.com", password: "pw" });
  expect(requiredValue(calls[0], "recorded test item").headers.has("authorization")).toBe(false);
  expect(
    requiredValue(
      parseSession(requiredValue(await storage.getItem(KEY), "stored session")),
      "stored session",
    ).refresh_token,
  ).toBe("refresh-1");
  expect(events).toEqual(["initial_session", "signed_in"]);

  await nelcota.from("notes").select().execute();
  expect(requiredValue(calls[1], "recorded test item").headers.get("authorization")).toBe(
    "Bearer access-1",
  );
});

it("password sign-in: returns the server error and stores nothing", async () => {
  const { nelcota, storage } = setup(
    memoryStorage(),
    json({ code: "invalid_grant", message: "no" }, 400),
  );
  const { error } = await nelcota.auth.signInWithPassword({ email: "a@x.com", password: "bad" });
  expect(error).toMatchObject({ status: 400, code: "invalid_grant" });
  expect(await storage.getItem(KEY)).toBeNull();
});

it("password sign-in: sign-up without a session while the email awaits confirmation", async () => {
  const { nelcota, storage } = setup(memoryStorage(), json({ user: session().user }, 201));
  const { data } = await nelcota.auth.signUp({
    email: "ana@example.com",
    password: "pw",
    data: { name: "Ana" },
  });
  expect(data?.session).toBeNull();
  expect(data?.user.email).toBe("ana@example.com");
  expect(await storage.getItem(KEY)).toBeNull();
});
