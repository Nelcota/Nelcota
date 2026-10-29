import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";

import { parseSession } from "../../src/auth/session.js";
import { requiredValue } from "../../src/core/required-value.js";
import { KEY, setup, stored } from "./auth-fixtures.js";
import {
  browserClients,
  installSerialLocks,
  installStaleSnapshotLocks,
  installBroadcastChannel,
  nativeBrowserStorage,
} from "./browser-environment.js";
import { gate } from "./gate.js";
import { json, mockFetch, session } from "./http-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "refresh: coalesces a late native-browser refresh while another tab is rotating (warm=%s)",
  async (warm) => {
    nativeBrowserStorage([[KEY, JSON.stringify(session())]]);
    const rotation = controlledRotation();
    const { clients, started, queued, releaseFirst } = rotation;
    try {
      await requiredValue(clients[0], "recorded test item").auth.getSession();
      if (warm) await Promise.all(clients.slice(1).map((client) => client.auth.getSession()));
      const first = requiredValue(clients[0], "recorded test item").auth.refreshSession();
      await started;
      const later = clients.slice(1).map((client) => client.auth.refreshSession());
      await queued;
      expect(rotation.count()).toBe(1);
      releaseFirst();
      const results = await Promise.all([first, ...later]);
      expect(rotation.count()).toBe(1);
      expect(results.every((result) => result.error === null)).toBe(true);
      expect(results.map((result) => result.data?.refresh_token)).toEqual([
        "refresh-2",
        "refresh-2",
        "refresh-2",
      ]);
      const subsequent = await requiredValue(
        clients[1],
        "recorded test item",
      ).auth.refreshSession();
      expect(rotation.count()).toBe(2);
      expect(subsequent.data?.refresh_token).toBe("refresh-3");
      // A stale per-client cache must not suppress a later explicit refresh.
      const following = await requiredValue(clients[0], "recorded test item").auth.refreshSession();
      expect(rotation.count()).toBe(3);
      expect(following.data?.refresh_token).toBe("refresh-4");
    } finally {
      releaseFirst();
      clients.forEach((client) => client.dispose());
    }
  },
);

it("refresh: leaves the lock-grant task before reading a native storage snapshot", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  let committed = JSON.stringify(session(5));
  let visible = committed;
  const storage = {
    getItem: () => visible,
    setItem: (_key: string, value: string) => {
      committed = visible = value;
    },
    removeItem: () => {
      committed = visible = "";
    },
  };
  vi.stubGlobal("localStorage", storage);
  installStaleSnapshotLocks(
    () => committed,
    (value) => {
      visible = value;
    },
  );
  const mock = mockFetch(
    json(session(900, "refresh-2", "access-2")),
    json(session(900, "refresh-3", "access-3")),
  );
  const clients = browserClients(mock.fetch, 2);
  try {
    const results = await Promise.all(clients.map((client) => client.auth.getSession()));
    expect(mock.calls).toHaveLength(1);
    expect(results.map((result) => result.data?.refresh_token)).toEqual(["refresh-2", "refresh-2"]);
  } finally {
    clients.forEach((client) => client.dispose());
  }
});

it("refresh: observes native writes published after the previous owner releases the lock", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  const committed = new Map([[KEY, JSON.stringify(session(5))]]);
  const storage = {
    getItem: (key: string) => committed.get(key) ?? null,
    // Firefox can publish a native localStorage write at a task boundary,
    // after its synchronous setItem has already returned.
    setItem: (key: string, value: string) => {
      setTimeout(() => committed.set(key, value), 0);
    },
    removeItem: (key: string) => {
      setTimeout(() => committed.delete(key), 0);
    },
  };
  vi.stubGlobal("localStorage", storage);
  installSerialLocks();
  const mock = mockFetch(
    json(session(900, "refresh-2", "access-2")),
    json(session(900, "refresh-3", "access-3")),
  );
  const clients = browserClients(mock.fetch, 2);
  try {
    const results = await Promise.all(clients.map((client) => client.auth.getSession()));
    expect(mock.calls).toHaveLength(1);
    expect(results.map((result) => result.data?.refresh_token)).toEqual(["refresh-2", "refresh-2"]);
    await vi.waitFor(() =>
      expect(
        requiredValue(
          parseSession(requiredValue(storage.getItem(KEY), "stored session")),
          "stored session",
        ).refresh_token,
      ).toBe("refresh-2"),
    );
  } finally {
    clients.forEach((client) => client.dispose());
  }
});

it("refresh: uses another tab's replacement when its broadcast reload overtakes an expired read", async () => {
  const channel = installBroadcastChannel();
  const storage = stored(session(5));
  const replacement = session(900, "refresh-2", "access-2");
  let queue = Promise.resolve(),
    requests = 0;
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(_name: string, task: () => Promise<T>) => {
        const number = ++requests;
        const run = queue.then(async () => {
          const value = await task();
          if (number === 1) {
            // The first read captured the expiring session. Another tab
            // publishes and broadcasts its replacement before that read settles.
            await storage.setItem(KEY, JSON.stringify(replacement));
            channel.onmessage?.({ data: "changed" });
          }
          return value;
        });
        queue = run.then(
          () => {},
          () => {},
        );
        return run;
      },
    },
  });
  const { nelcota, calls } = setup(storage, json(session(900, "refresh-3", "access-3")));
  try {
    const result = await nelcota.auth.getSession();
    expect(result.data?.refresh_token).toBe("refresh-2");
    expect(calls).toHaveLength(0);
    expect(
      requiredValue(
        parseSession(requiredValue(await storage.getItem(KEY), "stored session")),
        "stored session",
      ).refresh_token,
    ).toBe("refresh-2");
  } finally {
    nelcota.dispose();
  }
});

function controlledRotation() {
  let pending = false;
  let waiting = 0;
  const { promise: started, open: firstStarted } = gate();
  const { promise: release, open: releaseFirst } = gate();
  const { promise: queued, open: laterQueued } = gate();
  installSerialLocks(() => {
    if (pending && ++waiting === 2) laterQueued();
  });
  let rotations = 0;
  const mock = mockFetch(async () => {
    rotations++;
    if (rotations === 1) {
      pending = true;
      firstStarted();
      await release;
      pending = false;
    }
    return json(session(900, `refresh-${rotations + 1}`, `access-${rotations + 1}`));
  });
  const clients = browserClients(mock.fetch, 3);

  return { clients, started, queued, releaseFirst, count: () => rotations };
}
