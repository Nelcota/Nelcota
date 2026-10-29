import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";

import { memoryStorage, createClient, type FetchLike } from "../../src/index.js";

/** Installs synchronous native storage and a fresh committed receipt database. */
export function nativeBrowserStorage(initial: Iterable<readonly [string, string]> = []) {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  const values = new Map(initial);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}
/** Models independent named FIFO Web Lock queues without rejecting the queue tail. */
export function installWebLocks(enabled = true, absent = false): void {
  const queues = new Map<string, Promise<void>>();
  vi.stubGlobal(
    "navigator",
    enabled
      ? {
          locks: {
            request: <T>(name: string, task: () => Promise<T>) => {
              const result = (queues.get(name) ?? Promise.resolve()).then(task);
              queues.set(
                name,
                result.then(
                  () => undefined,
                  () => undefined,
                ),
              );
              return result;
            },
          },
        }
      : unavailableNavigator(absent),
  );
}

/** Installs native receipt coordination without changing the available broadcast transport. */
export function installNativeJournal(factory = new IDBFactory()): IDBFactory {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("indexedDB", factory);
  return factory;
}
/** Models one global FIFO lock queue, including observation of pending requests. */
export function installSerialLocks(queued?: () => void): void {
  let queue: Promise<unknown> = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(_name: string, task: () => Promise<T>) => {
        queued?.();
        const run = queue.then(task);
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    },
  });
}
/** Models a tab whose native storage view catches up on the task after lock grant. */
export function installStaleSnapshotLocks(
  read: () => string,
  visible: (value: string) => void,
): void {
  let queue: Promise<unknown> = Promise.resolve();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(_name: string, task: () => Promise<T>) => {
        const snapshot = read();
        const result = queue.then(() => {
          visible(snapshot);
          setTimeout(() => visible(read()), 0);
          return task();
        });
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  });
}
/** Gives one test direct control over its browser broadcast notification. */
export function installBroadcastChannel() {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  const channel: {
    onmessage?: (event: { data: string }) => void;
    close: () => void;
    postMessage: () => void;
  } = { close() {}, postMessage() {} };
  vi.stubGlobal("BroadcastChannel", function BroadcastChannelFixture() {
    return channel;
  });
  return channel;
}

/** Creates browser clients with identical transport and disabled background refresh. */
export function browserClients(fetch: FetchLike, count: number) {
  return Array.from({ length: count }, () =>
    createClient("https://api.example.com", { fetch, auth: { autoRefresh: false } }),
  );
}

function unavailableNavigator(absent: boolean): object | undefined {
  if (absent) return undefined;
  return {};
}
