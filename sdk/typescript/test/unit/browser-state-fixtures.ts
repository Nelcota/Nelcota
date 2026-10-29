import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";

import { session } from "./http-fixtures.js";

const KEY = "nelcota.api.example.com.session";

function browser() {
  const original = JSON.stringify(session(5));
  // A different WebKit process can retain its native storage snapshot even
  // after Web Locks has handed ownership to the next tab. No timer fixes it.
  const storage = { getItem: () => original, setItem: vi.fn(), removeItem: vi.fn() };
  const factory = new IDBFactory();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("indexedDB", factory);
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: <T>(name: string, callback: () => Promise<T>) => {
        const result = (queues.get(name) ?? Promise.resolve()).then(callback);
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
  });
  return { storage, factory };
}

function pkceBrowser() {
  browser();
  const storage = {
    getItem: (key: string) =>
      key.endsWith(".pkce") ? "stale-verifier" : JSON.stringify(session()),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}
export { KEY, browser, pkceBrowser };
