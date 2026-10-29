import { expect, it } from "vitest";

import { createClient, memoryStorage, type AuthEvent, type Session } from "../../src/index.js";
import { json, mockFetch, session } from "./http-fixtures.js";

const key = "initial-session-test";
it.each([null, session(0)])(
  "initial session subscription: reads the baseline before announcing a token refresh",
  async (initial) => {
    const storage = memoryStorage();
    await storage.setItem(key, JSON.stringify(initial));
    const mock = mockFetch(json(session(900, "rotated")));
    const client = createClient("https://api.example.com", {
      fetch: mock.fetch,
      auth: { storage, storageKey: key, autoRefresh: false },
    });
    const events: [AuthEvent, Session | null][] = [];
    try {
      client.auth.onChange((event, value) => {
        events.push([event, value]);
      });
      await client.auth.getSession();
      expect(events[0]).toEqual(["initial_session", initial]);
      expect(events.map(([event]) => event)).toEqual(
        initial != null ? ["initial_session", "refreshed"] : ["initial_session"],
      );
    } finally {
      client.dispose();
    }
  },
);

it("initial session subscription: unsubscribes or disposes before storage finishes without a late callback", async () => {
  const client = createClient("https://api.example.com", { auth: { autoRefresh: false } });
  let called = false;
  const stop = client.auth.onChange(() => {
    called = true;
  });
  stop();
  client.auth.onChange(() => {
    called = true;
  });
  client.dispose();
  await Promise.resolve();
  await Promise.resolve();
  expect(called).toBe(false);
});

it("initial session subscription: delivers one baseline per subscription and permits auth calls from the listener", async () => {
  const client = createClient("https://api.example.com", { auth: { autoRefresh: false } });
  const events: AuthEvent[] = [];
  let read: Promise<unknown> | undefined;
  try {
    client.auth.onChange((event) => {
      events.push(event);
      read = client.auth.getSession();
    });
    await client.auth.setSession(session());
    await read;
    expect(events).toEqual(["initial_session", "signed_in"]);
    const late: AuthEvent[] = [];
    client.auth.onChange((event) => {
      late.push(event);
    });
    await client.auth.getSession();
    expect(late).toEqual(["initial_session"]);
  } finally {
    client.dispose();
  }
});
