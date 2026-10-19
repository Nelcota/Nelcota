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

  constructor(name: string, onMessage: () => void) {
    if (typeof BroadcastChannel === 'undefined') return;
    this.#channel = new BroadcastChannel(name);
    this.#channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === 'changed') onMessage();
    };
    // Node keeps the process alive while a channel is open.
    (this.#channel as { unref?: () => void }).unref?.();
  }

  notify(): void {
    this.#channel?.postMessage('changed' satisfies SessionSignal);
  }

  close(): void {
    this.#channel?.close();
    this.#channel = undefined;
  }
}
