/** Where the client runs: page, worker or server. */

/** A page with a DOM (not a worker and not a server). */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/** A Web or Service Worker global. */
export function isWorkerScope(): boolean {
  const scope = (globalThis as { WorkerGlobalScope?: abstract new () => unknown })
    .WorkerGlobalScope;
  return typeof scope === "function" && globalThis instanceof scope;
}
