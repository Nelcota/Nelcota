import { afterEach, expect, it, vi } from "vitest";

import { BrowserRefreshPendingError } from "../../src/auth/browser/session.errors.js";
import {
  BrowserSessionState,
  MAX_RESERVATION_HOLD_IN_MS,
  MIRROR_SETTLE_IN_MS,
  RESERVATION_LEASE_IN_MS,
} from "../../src/auth/browser/state.js";
import { createClient } from "../../src/index.js";
import { KEY, browser } from "./browser-state-fixtures.js";
import { gate } from "./gate.js";
import { json, mockFetch, session } from "./http-fixtures.js";

const STEPS_PER_LEASE = 4;
const STEP_IN_MS = RESERVATION_LEASE_IN_MS / STEPS_PER_LEASE;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Writes a receipt as an older SDK would, bypassing validation. */
async function putReceipt(factory: IDBFactory, value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open("nelcota.auth", 1);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("sessions", "readwrite");
      transaction.objectStore("sessions").put(value, KEY);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error("Fixture transaction aborted without a reason"));
      };
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Fixture database request failed without a reason"));
  });
}

it("keeps a reservation alive while a refresh outlasts the lease", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const { factory } = browser();
  const original = session(5);
  const { promise: started, open: start } = gate();
  const { promise: response, open: respond } = gate();
  const mock = mockFetch(async () => {
    start();
    await response;
    return json(session(900, "replacement", "new-access"));
  });
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  const other = new BrowserSessionState(KEY, factory);
  try {
    const refresh = client.auth.refreshSession();
    await started;
    // Two leases pass while the request is in flight: no other tab may spend
    // the reserved token.
    for (let step = 0; step < 2 * STEPS_PER_LEASE; step++) {
      vi.advanceTimersByTime(STEP_IN_MS);
      // oxlint-disable-next-line no-await-in-loop -- Each check follows the renewal its clock step triggered.
      await expect(other.reserve(original)).rejects.toBeInstanceOf(BrowserRefreshPendingError);
    }
    respond();
    expect((await refresh).data?.refresh_token).toBe("replacement");
    expect(vi.getTimerCount()).toBe(0);
    expect(mock.calls).toHaveLength(1);
  } finally {
    respond();
    client.dispose();
  }
});

it("stops renewing once the owner settles its reservation", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const { factory } = browser();
  const owner = new BrowserSessionState(KEY, factory);
  const other = new BrowserSessionState(KEY, factory);
  const original = session(5);
  await owner.read(() => JSON.stringify(original));
  await owner.reserve(original);
  const stop = owner.hold();
  vi.advanceTimersByTime(STEP_IN_MS * 2);
  await stop();
  expect(vi.getTimerCount()).toBe(0);
  // A closed tab's last renewal still expires with the lease.
  vi.advanceTimersByTime(RESERVATION_LEASE_IN_MS);
  await expect(other.reserve(original)).resolves.toBeUndefined();
});

it("lets a refresh without a request timeout hold its reservation for at most two minutes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const { factory } = browser();
  const original = session(5);
  const { promise: started, open: start } = gate();
  const { promise: response, open: respond } = gate();
  const mock = mockFetch(async () => {
    start();
    await response;
    return json(session(900, "replacement", "new-access"));
  });
  const client = createClient("https://api.example.com", {
    fetch: mock.fetch,
    timeout: 0,
    auth: { autoRefresh: false },
  });
  const other = new BrowserSessionState(KEY, factory);
  try {
    const refresh = client.auth.refreshSession();
    await started;
    const steps = MAX_RESERVATION_HOLD_IN_MS / STEP_IN_MS;
    for (let step = 0; step < steps; step++) {
      vi.advanceTimersByTime(STEP_IN_MS);
      // oxlint-disable-next-line no-await-in-loop -- Each check follows the renewal its clock step triggered.
      await expect(other.reserve(original)).rejects.toBeInstanceOf(BrowserRefreshPendingError);
    }
    // Past the hold the next tick stops renewing; the last renewal still stands.
    vi.advanceTimersByTime(2 * STEP_IN_MS);
    await expect(other.reserve(original)).rejects.toBeInstanceOf(BrowserRefreshPendingError);
    expect(vi.getTimerCount()).toBe(0);
    // The request is still open, but the reservation lapses with its lease.
    vi.advanceTimersByTime(RESERVATION_LEASE_IN_MS);
    await expect(other.reserve(original)).resolves.toBeUndefined();
    respond();
    // The superseded owner's late answer cannot overwrite the newer state.
    await refresh;
  } finally {
    respond();
    client.dispose();
  }
});

it("caps renewal at the request timeout when it is shorter than two minutes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const { factory } = browser();
  const owner = new BrowserSessionState(KEY, factory);
  const other = new BrowserSessionState(KEY, factory);
  const original = session(5);
  await owner.read(() => JSON.stringify(original));
  await owner.reserve(original);
  const timeoutInMs = 2 * RESERVATION_LEASE_IN_MS;
  const stop = owner.hold(timeoutInMs);
  try {
    for (let step = 0; step < timeoutInMs / STEP_IN_MS; step++) {
      vi.advanceTimersByTime(STEP_IN_MS);
      // oxlint-disable-next-line no-await-in-loop -- Each check follows the renewal its clock step triggered.
      await expect(other.reserve(original)).rejects.toBeInstanceOf(BrowserRefreshPendingError);
    }
    vi.advanceTimersByTime(2 * STEP_IN_MS);
    await expect(other.reserve(original)).rejects.toBeInstanceOf(BrowserRefreshPendingError);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(RESERVATION_LEASE_IN_MS);
    await expect(other.reserve(original)).resolves.toBeUndefined();
  } finally {
    await stop();
  }
});

it("waits a full lease before taking over a reservation written without a time", async () => {
  const { factory } = browser();
  const original = session(5);
  const state = new BrowserSessionState(KEY, factory);
  await state.read(() => JSON.stringify(original));
  await putReceipt(factory, {
    kind: "refreshing",
    owner: "older-sdk-tab",
    value: JSON.stringify(original),
  });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await expect(state.reserve(original)).rejects.toBeInstanceOf(BrowserRefreshPendingError);
  clock.mockReturnValue(now + RESERVATION_LEASE_IN_MS - 1);
  await expect(state.reserve(original)).rejects.toBeInstanceOf(BrowserRefreshPendingError);
  // A different untimed reservation restarts the clock.
  await putReceipt(factory, {
    kind: "refreshing",
    owner: "another-older-tab",
    value: JSON.stringify(original),
  });
  clock.mockReturnValue(now + RESERVATION_LEASE_IN_MS);
  await expect(state.reserve(original)).rejects.toBeInstanceOf(BrowserRefreshPendingError);
  clock.mockReturnValue(now + 2 * RESERVATION_LEASE_IN_MS);
  await expect(state.reserve(original)).resolves.toBeUndefined();
});

it("waits the settle window from first sight before an untimed ready receipt's missing mirror signs out", async () => {
  const { factory } = browser();
  const value = JSON.stringify(session(900));
  await new BrowserSessionState(KEY, factory).read(() => null);
  // An older SDK committed the journal; its localStorage write has not landed yet.
  await putReceipt(factory, { kind: "ready", owner: "older-sdk-tab", value });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const state = new BrowserSessionState(KEY, factory);
  expect((await state.read(() => null)).value).toBe(value);
  clock.mockReturnValue(now + MIRROR_SETTLE_IN_MS - 1);
  expect((await state.read(() => null)).value).toBe(value);
  // A tab that first sees it later starts its own clock.
  const later = new BrowserSessionState(KEY, factory);
  expect((await later.read(() => null)).value).toBe(value);
  // Once settled, a mirror that is still missing was cleared on purpose.
  clock.mockReturnValue(now + MIRROR_SETTLE_IN_MS);
  expect((await state.read(() => null)).value).toBeNull();
  expect((await later.read(() => null)).value).toBeNull();
});
