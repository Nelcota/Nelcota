import type { Result } from "../../core/client.errors.js";
import { promiseResult } from "../../core/promise-result.js";
import { Broadcast } from "../browser/coordination.js";
import { QUICK_RETRY_REFRESH_MS, RefreshScheduler, RETRY_REFRESH_MS } from "../scheduler.js";
import type { Session } from "../session.js";
import type { SessionStore } from "../store.js";
import type { AuthEvent, AuthListener } from "../types.js";

interface BackgroundContext {
  store: SessionStore;
  browser: boolean;
  callerOwned: boolean;
  refresh: boolean;
  marginFor: (session: Session) => number;
  locked: <T>(task: () => Promise<T>) => Promise<T>;
  current: () => Promise<Session | null>;
  get: () => Promise<Result<Session | null>>;
  reload: (event?: AuthEvent, revision?: string) => Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
}

/** Owns refresh scheduling, broadcasts and observed listener failures. */
export class SessionBackground {
  readonly #scheduler: RefreshScheduler;
  readonly #broadcast: Broadcast | undefined;
  readonly #listeners = new Set<{ listener: AuthListener; ready: boolean }>();
  constructor(private readonly context: BackgroundContext) {
    this.#scheduler = new RefreshScheduler(context.refresh, context.marginFor, () => this.#tick());
    if (context.browser && privateStorage(context.store) === false)
      this.#broadcast = new Broadcast(`${context.store.key}.channel`, (event, revision) =>
        this.observe(context.reload(event, revision)),
      );
    if (this.#scheduler.enabled)
      this.observe(context.current().then((session) => this.#scheduler.schedule(session)));
  }
  schedule(session: Session | null, delayInMs?: number): void {
    this.#scheduler.schedule(session, delayInMs);
  }
  notify(event?: AuthEvent, revision?: string): void {
    this.#broadcast?.notify(event, revision);
  }
  onChange(listener: AuthListener): () => void {
    const subscription = { listener, ready: false };
    this.#listeners.add(subscription);
    // The lifecycle lock orders this baseline before subsequent writes/refreshes.
    // Invoke without awaiting user code: listeners may call auth methods themselves.
    this.observe(
      this.context.locked(async () => {
        const session = this.context.callerOwned ? null : await this.context.store.read();
        if (this.#listeners.has(subscription) === false) return;
        subscription.ready = true;
        this.observe(
          promiseResult(() => listener("initial_session", session)),
          false,
        );
      }),
    );
    return () => this.#listeners.delete(subscription);
  }
  emit(event: AuthEvent, session: Session | null): void {
    for (const subscription of this.#listeners) {
      if (subscription.ready === false) continue;
      this.observe(
        promiseResult(() => subscription.listener(event, session)),
        false,
      );
    }
  }

  #retries = 0;
  #tick(): void {
    this.observe(
      this.context.get().then(async ({ data, error }) => {
        if (error != null && error.code !== "invalid_grant" && error.code !== "session_missing") {
          this.#scheduler.schedule(
            await this.context.current(),
            this.#retries++ === 0 ? QUICK_RETRY_REFRESH_MS : RETRY_REFRESH_MS,
          );
          return;
        }
        this.#retries = 0;
        if (this.context.store.dirty === false) this.#scheduler.schedule(data);
      }),
    );
  }
  observe(operation: Promise<unknown>, pause = true): void {
    void operation.catch(async (error) => {
      if (this.#scheduler.disposed) return;
      if (pause) this.#scheduler.schedule(null);
      // Listener failures do not pause refresh. Error handlers are isolated.
      try {
        await this.context.onError(error);
      } catch {
        /* Includes asynchronous handler failures. */
      }
    });
  }
  dispose(): void {
    this.#scheduler.dispose();
    this.#broadcast?.close();
    this.#listeners.clear();
  }
}

function privateStorage(store: SessionStore): boolean {
  try {
    return store.storage === globalThis.sessionStorage;
  } catch {
    // Sandboxed storage cannot participate in private-tab identity checks.
    return false;
  }
}
