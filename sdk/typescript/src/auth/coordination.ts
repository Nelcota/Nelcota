import type { SessionStorage } from './session.js';
import type { AuthEvent } from './types.js';
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
export function workerScope(): boolean {
  const scope = (globalThis as { WorkerGlobalScope?: abstract new () => unknown }).WorkerGlobalScope;
  return typeof scope === 'function' && globalThis instanceof scope && locks() !== undefined;
}

const adapters = new WeakMap<SessionStorage, Map<string, symbol>>();
export function adapterLock(storage: SessionStorage, key: string): symbol {
  let keys = adapters.get(storage);
  if (!keys) { keys = new Map(); adapters.set(storage, keys); }
  let lock = keys.get(key);
  if (!lock) { lock = Symbol(); keys.set(key, lock); }
  return lock;
}

/**
 * The lock that serializes one session's lifecycle. Server adapters belong to
 * separate requests: queue by adapter identity so another client's sign-in
 * cannot block them. Worker storage supplied by the caller may be shared with
 * tabs, so it keeps the cross-context Web Lock, like browsers.
 */
export function sessionLock(storage: SessionStorage, key: string, browser: boolean, supplied: boolean): string | symbol {
  return browser || (supplied && workerScope()) ? `${key}.refresh` : adapterLock(storage, key);
}

const pending = new Map<string | symbol, Promise<void>>();

/** Web Locks across tabs, or a queue shared by clients in this module instance. */
export function withLock<T>(name: string | symbol, task: () => Promise<T>): Promise<T> {
  if (typeof name === 'string') {
    const manager = locks();
    if (manager) return manager.request(name, task);
  }
  const run = (pending.get(name) ?? Promise.resolve()).then(task);
  const tail = run.then(() => undefined, () => undefined);
  pending.set(name, tail);
  void tail.then(() => {
    if (pending.get(name) === tail) pending.delete(name);
  });
  return run;
}

export type SessionSignal = 'changed';

export class Broadcast {
  #channel: BroadcastChannel | undefined;

  constructor(name: string, onMessage: (event?: AuthEvent, revision?: string) => void) {
    if (typeof BroadcastChannel === 'undefined') return;
    this.#channel = new BroadcastChannel(name);
    this.#channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === 'changed') { onMessage(); return; }
      const data = event.data as { event?: unknown; revision?: unknown } | null;
      if (data && typeof data === 'object' && ['signed_in', 'signed_out', 'refreshed', 'user_updated'].includes(data.event as string) && typeof data.revision === 'string' && data.revision.length === 64) onMessage(data.event as AuthEvent, data.revision);
    };
    // Node keeps the process alive while a channel is open.
    (this.#channel as { unref?: () => void }).unref?.();
  }

  notify(event?: AuthEvent, revision?: string): void {
    if (event && revision) this.#channel?.postMessage({ event, revision });
    // Older tabs only recognize this signal. New receivers deduplicate by state.
    this.#channel?.postMessage('changed');
  }

  close(): void {
    this.#channel?.close();
    this.#channel = undefined;
  }
}
