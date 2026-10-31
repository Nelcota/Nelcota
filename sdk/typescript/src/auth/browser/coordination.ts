import { isWorkerScope } from "../../core/runtime.js";
import { RANDOM_ID_CHARS } from "../../core/runtime.js";
import type { SessionStorage } from "../session.js";
import type { AuthEvent } from "../types.js";

/**
 * Coordination between tabs of the same app. The server ends a session when a
 * refresh token is used twice (reuse detection), so two tabs refreshing the
 * same session at once would sign the person out: refreshes take a Web Lock,
 * and each change is broadcast so other tabs drop their cached copy.
 */

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function locks(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks;
}

/** Web and Service Workers share Web Locks with same-origin tabs; servers do not. */
function workerScope(): boolean {
  return isWorkerScope() && locks() !== undefined;
}

const adapters = new WeakMap<SessionStorage, Map<string, symbol>>();
function adapterLock(storage: SessionStorage, key: string): symbol {
  let keys = adapters.get(storage);
  if (keys == null) {
    keys = new Map();
    adapters.set(storage, keys);
  }
  let lock = keys.get(key);
  if (lock === undefined) {
    lock = Symbol();
    keys.set(key, lock);
  }
  return lock;
}

/**
 * The lock that serializes one session's lifecycle or PKCE state. Server adapters belong to
 * separate requests: queue by adapter identity so another client's sign-in
 * cannot block them. Worker storage supplied by the caller may be shared with
 * tabs, so it keeps the cross-context Web Lock, like browsers.
 */
export function sessionLock(
  storage: SessionStorage,
  key: string,
  {
    browser,
    supplied,
    kind = "refresh",
  }: { browser: boolean; supplied: boolean; kind?: "refresh" | "pkce" },
): string | symbol {
  return browser || (supplied && workerScope())
    ? `${key}.${kind}`
    : adapterLock(storage, `${key}.${kind}`);
}

const pending = new Map<string | symbol, Promise<void>>();

/** Web Locks across tabs, or a queue shared by clients in this module instance. */
export function withLock<T>(name: string | symbol, task: () => Promise<T>): Promise<T> {
  if (typeof name === "string") {
    const manager = locks();
    if (manager != null) return manager.request(name, task);
  }
  const run = (pending.get(name) ?? Promise.resolve()).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  pending.set(name, tail);
  void tail.then(() => {
    if (pending.get(name) === tail) pending.delete(name);
  });
  return run;
}

export class Broadcast {
  #channel: BroadcastChannel | undefined;
  /** Legacy signals announced by structured messages and not yet received. */
  #duplicates = 0;

  constructor(name: string, onMessage: (event?: AuthEvent, revision?: string) => void) {
    if (typeof BroadcastChannel === "undefined") return;
    this.#channel = new BroadcastChannel(name);
    this.#channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data !== "changed") {
        const data = event.data as { event?: unknown; revision?: unknown; legacy?: unknown } | null;
        if (typeof data !== "object" || data === null) return;
        if (data.legacy === true) this.#duplicates++;
        if (
          ["signed_in", "signed_out", "refreshed", "user_updated"].includes(data.event as string) &&
          typeof data.revision === "string" &&
          data.revision.length === RANDOM_ID_CHARS
        )
          onMessage(data.event as AuthEvent, data.revision);
        return;
      }
      // One sender's messages arrive in order: this copy follows its structured message.
      if (this.#duplicates > 0) this.#duplicates--;
      else onMessage();
    };
    // Node keeps the process alive while a channel is open.
    (this.#channel as { unref?: () => void }).unref?.();
  }

  /**
   * The structured form when the change has an event and a committed revision,
   * followed by the legacy `"changed"` signal for tabs running SDK 0.2.1 or
   * older; `legacy` tells current receivers to skip that copy. A change without
   * a revision sends only the legacy signal.
   */
  notify(event?: AuthEvent, revision?: string): void {
    if (event != null && revision != null && revision !== "")
      this.#channel?.postMessage({ event, revision, legacy: true });
    this.#channel?.postMessage("changed");
  }

  close(): void {
    this.#channel?.close();
    this.#channel = undefined;
  }
}
