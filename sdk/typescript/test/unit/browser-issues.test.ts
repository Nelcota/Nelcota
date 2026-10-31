import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";

import { Broadcast } from "../../src/auth/browser/coordination.js";
import {
  BrowserSessionState,
  MIRROR_SETTLE_IN_MS,
  RESERVATION_LEASE_IN_MS,
} from "../../src/auth/browser/state.js";
import { requiredValue } from "../../src/core/required-value.js";
import { RANDOM_ID_CHARS } from "../../src/core/runtime.js";
import {
  createClient,
  memoryStorage,
  type AuthEvent,
  type NelcotaClient,
  type FetchLike,
} from "../../src/index.js";
import { installWebLocks } from "./browser-environment.js";
import { json, mockFetch, session } from "./http-fixtures.js";
const KEY = "nelcota.api.example.com.session";
const clients: NelcotaClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function browser() {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("indexedDB", new IDBFactory());
  const values = new Map<string, string>();
  const native = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  vi.stubGlobal("localStorage", native);
  installWebLocks();
  const channels = new Set<Channel>();
  const messages: unknown[] = [];
  class Channel {
    onmessage: ((event: { data: unknown }) => void) | undefined;
    constructor(readonly name: string) {
      channels.add(this);
    }
    postMessage(data: unknown): void {
      messages.push(data);
      for (const peer of channels)
        if (peer !== this && peer.name === this.name)
          queueMicrotask(() => peer.onmessage?.({ data }));
    }
    close(): void {
      channels.delete(this);
    }
  }
  vi.stubGlobal("BroadcastChannel", Channel);
  return { native, channels, messages };
}
function client(fetch?: FetchLike, storage?: ReturnType<typeof memoryStorage>) {
  const result = createClient("https://api.example.com", {
    ...(fetch != null ? { fetch } : {}),
    auth: { autoRefresh: false, ...(storage != null ? { storage } : {}) },
  });
  clients.push(result);
  return result;
}
it("releases a definite rate-limit reservation for other tabs (#137)", async () => {
  browser();
  const mock = mockFetch(json({ code: "rate_limited", message: "Busy" }, 429));
  const first = client(mock.fetch);
  await first.auth.setSession(session());
  const events: AuthEvent[] = [];
  first.auth.onChange((event) => events.push(event));
  expect((await first.auth.refreshSession()).error?.code).toBe("rate_limited");
  first.dispose();
  const other = client();
  expect((await other.auth.getSession()).data?.refresh_token).toBe("refresh-1");
  expect(mock.calls).toHaveLength(1);
  expect(events).toEqual(["initial_session"]);
});
it("releases the reservation after any other definite client error (#137)", async () => {
  browser();
  const first = client(
    mockFetch(json({ code: "unsupported_grant_type", message: "Rejected" }, 400)).fetch,
  );
  await first.auth.setSession(session());
  expect((await first.auth.refreshSession()).error?.status).toBe(400);
  first.dispose();
  expect((await client().auth.getSession()).data?.refresh_token).toBe("refresh-1");
});
it("keeps a gateway failure fenced because rotation may have committed (#137)", async () => {
  browser();
  const first = client(
    mockFetch(json({ code: "unavailable", message: "Gateway failure" }, 503)).fetch,
  );
  await first.auth.setSession(session());
  expect((await first.auth.refreshSession()).error?.status).toBe(503);
  first.dispose();
  const mock = mockFetch(json(session(900, "taken-over", "taken-over-access")));
  const other = client(mock.fetch);
  // The reserved session stays readable; only its rotation waits for the lease.
  expect((await other.auth.getSession()).data?.refresh_token).toBe("refresh-1");
  expect((await other.auth.refreshSession()).error?.code).toBe("refresh_pending");
  expect(mock.calls).toHaveLength(0);
  // Past the lease the owner is presumed gone: the reservation is taken over.
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + RESERVATION_LEASE_IN_MS);
  expect((await other.auth.refreshSession()).data?.refresh_token).toBe("taken-over");
  expect(mock.calls).toHaveLength(1);
});
it("recovers a reservation left by a tab that closed mid-refresh after reload (#1)", async () => {
  browser();
  await client().auth.setSession(session(30));
  // A tab that closed mid-refresh: its committed reservation has no owner left.
  const closed = new BrowserSessionState(KEY, globalThis.indexedDB);
  await closed.read(() => JSON.stringify(session(30)));
  await closed.reserve(session(30));
  const mock = mockFetch(json(session(900, "recovered", "recovered-access")));
  const reloaded = client(mock.fetch);
  // Within the lease the still-valid access token keeps working, without HTTP.
  const early = await reloaded.auth.getSession();
  expect(early.error).toBeNull();
  expect(early.data?.refresh_token).toBe("refresh-1");
  expect(mock.calls).toHaveLength(0);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + RESERVATION_LEASE_IN_MS);
  const { data, error } = await reloaded.auth.refreshSession();
  expect(error).toBeNull();
  expect(data?.refresh_token).toBe("recovered");
  expect(mock.calls).toHaveLength(1);
});
it("treats a removed localStorage mirror as sign-out once the receipt has settled (#5)", async () => {
  const environment = browser();
  const first = client();
  await first.auth.setSession(session());
  environment.native.removeItem(KEY);
  // Just after a commit the mirror may still be on its way: keep the session.
  expect((await first.auth.getSession()).data?.refresh_token).toBe("refresh-1");
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + MIRROR_SETTLE_IN_MS);
  const reloaded = client();
  expect((await reloaded.auth.getSession()).data).toBeNull();
  // The journal was cleared too: the session does not come back.
  expect(
    (await new BrowserSessionState(KEY, globalThis.indexedDB).read(() => null)).value,
  ).toBeNull();
  expect((await first.auth.getSession()).data).toBeNull();
});
it("broadcasts each change for current and older SDKs and still accepts the legacy signal", async () => {
  const environment = browser();
  const first = client(),
    second = client();
  const events: AuthEvent[] = [];
  second.auth.onChange((event) => events.push(event));
  await vi.waitFor(() => expect(events).toEqual(["initial_session"]));
  environment.messages.length = 0;
  await first.auth.setSession(session());
  // Tabs on SDK 0.2.1 or older only understand "changed": it follows each change.
  expect(environment.messages).toEqual([
    { event: "signed_in", revision: expect.any(String) as unknown, legacy: true },
    "changed",
  ]);
  await vi.waitFor(() => expect(events).toEqual(["initial_session", "signed_in"]));
  // A tab running an older SDK commits without a structured message and only
  // sends "changed": the receiver reloads and infers the event.
  const replacement = JSON.stringify(session(900, "refresh-2", "access-2"));
  await new BrowserSessionState(KEY, globalThis.indexedDB).write(replacement);
  environment.native.setItem(KEY, replacement);
  const receiver = requiredValue([...environment.channels].at(-1), "receiving channel");
  receiver.onmessage?.({ data: "changed" });
  await vi.waitFor(() => expect(events).toEqual(["initial_session", "signed_in", "refreshed"]));
  expect((await second.auth.getSession()).data?.refresh_token).toBe("refresh-2");
});
it("labels profile and account changes in loaded and unread tabs (#138)", async () => {
  browser();
  const original = session();
  const changed = { ...original.user, user_metadata: { name: "updated" } };
  const replacement = {
    ...session(900, "bob-refresh", "bob-access"),
    user: { ...original.user, id: "bob", email: "bob@example.test" },
  };
  const first = client(mockFetch(json(changed), json(replacement)).fetch);
  await first.auth.setSession(original);
  const loaded = client(),
    unread = client();
  await loaded.auth.getSession();
  const events: AuthEvent[] = [],
    fresh: AuthEvent[] = [];
  loaded.auth.onChange((event) => events.push(event));
  unread.auth.onChange((event) => fresh.push(event));
  await first.auth.updateUser({ data: { name: "updated" } });
  await vi.waitFor(() => {
    expect(events).toEqual(["initial_session", "user_updated"]);
    expect(fresh).toEqual(["initial_session", "user_updated"]);
  });
  await first.auth.signInWithPassword({ email: "bob@example.test", password: "pw" });
  await vi.waitFor(() => {
    expect(events).toEqual(["initial_session", "user_updated", "signed_in"]);
    expect(fresh).toEqual(["initial_session", "user_updated", "signed_in"]);
  });
});
it("does not broadcast into independent per-tab adapters (#140)", async () => {
  const delayInMs = 20;

  browser();
  const isolated = memoryStorage();
  vi.stubGlobal("sessionStorage", isolated);
  const first = client(undefined, memoryStorage()),
    second = client(undefined, isolated);
  await first.auth.setSession(session());
  const own = { ...session(), user: { ...session().user, id: "carol" } };
  await second.auth.setSession(own);
  await second.auth.getSession();
  const events: AuthEvent[] = [];
  second.auth.onChange((event) => events.push(event));
  await first.auth.setSession({ ...session(), user: { ...session().user, id: "bob" } });
  await new Promise((resolve) => setTimeout(resolve, delayInMs));
  expect(events).toEqual(["initial_session"]);
  expect((await second.auth.getSession()).data?.user.id).toBe("carol");
});

it("does not label a newer identity with a delayed old logout event (#138)", async () => {
  const environment = browser();
  const replacement = { ...session(), user: { ...session().user, id: "bob" } };
  const first = client(mockFetch(new Response(null, { status: 204 }), json(replacement)).fetch);
  await first.auth.setSession(session());
  await first.auth.signOut();
  const stale = environment.messages.findLast(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "event" in value &&
      value.event === "signed_out",
  );
  await first.auth.signInWithPassword({ email: "bob@example.test", password: "pw" });
  const unread = client();
  const events: AuthEvent[] = [];
  unread.auth.onChange((event) => events.push(event));
  const channel = requiredValue([...environment.channels].at(-1), "required operation value");
  channel.onmessage?.({ data: stale });
  await vi.waitFor(() => expect(events).toEqual(["initial_session"]));
  expect((await unread.auth.getSession()).data?.user.id).toBe("bob");
});

it.each(["rotated", "invalid_grant"] as const)(
  "broadcasts only signed_out when sign-out renewal is %s",
  async (outcome) => {
    const reply =
      outcome === "rotated"
        ? json(session(900, "rotated", "fresh"))
        : json({ code: "invalid_grant", message: "Spent" }, 400);
    const environment = browser();
    const first = client(mockFetch(reply, new Response(null, { status: 204 })).fetch);
    await first.auth.setSession(session(-60));
    environment.messages.length = 0;
    await first.auth.signOut();
    expect(environment.messages.filter((value) => typeof value === "object")).toEqual([
      { event: "signed_out", revision: expect.any(String) as unknown, legacy: true },
    ]);
  },
);

it("handles a structured change once and still hears older tabs' legacy signals", async () => {
  browser();
  const name = `${KEY}.channel`;
  const received: [AuthEvent | undefined, string | undefined][] = [];
  const sender = new Broadcast(name, () => undefined),
    receiver = new Broadcast(name, (event, revision) => received.push([event, revision]));
  // Raw posts stand in for tabs running other SDK versions.
  const other = new BroadcastChannel(name);
  const revision = "r".repeat(RANDOM_ID_CHARS);
  try {
    sender.notify("refreshed", revision);
    await vi.waitFor(() => expect(received).toEqual([["refreshed", revision]]));
    // SDK 0.2.1 or older sends only the legacy signal.
    other.postMessage("changed");
    await vi.waitFor(() => expect(received).toHaveLength(2));
    // SDK 0.2.2 to 0.2.5 sends a structured message without a legacy copy, so
    // an older tab's later signal is not mistaken for one.
    other.postMessage({ event: "signed_out", revision });
    other.postMessage("changed");
    await vi.waitFor(() => expect(received).toHaveLength(4));
    expect(received).toEqual([
      ["refreshed", revision],
      [undefined, undefined],
      ["signed_out", revision],
      [undefined, undefined],
    ]);
  } finally {
    sender.close();
    receiver.close();
    other.close();
  }
});
