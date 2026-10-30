/** When the next background refresh is due. It owns the timer, not what the refresh does. */
import { MAX_TIMER_IN_MS, SECOND_IN_MS } from "../core/time.js";
import { secondsLeft, type Session } from "./session.js";

const MAX_REFRESH_JITTER_IN_MS = 5_000;

export const RETRY_REFRESH_MS = 10_000;
// First retry after an uncertain refresh: the server only takes the old token back within 10 s.
export const QUICK_RETRY_REFRESH_MS = 2_000;

/** How long a failed refresh waits: the server's Retry-After (seconds), else the quick retry. */
export function retryDelayInMs(retryAfter: number | undefined): number {
  return retryAfter === undefined ? QUICK_RETRY_REFRESH_MS : retryAfter * SECOND_IN_MS;
}

export class RefreshScheduler {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(
    readonly enabled: boolean,
    private readonly margin: (session: Session) => number,
    private readonly due: () => void,
  ) {}

  /** Replaces any pending refresh; `null` (or a disabled scheduler) leaves none. */
  schedule(session: Session | null, delayMs?: number): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#disposed || this.enabled === false || session == null) return;
    const remaining = secondsLeft(session);
    const wait = Math.max(0, (remaining - this.margin(session)) * SECOND_IN_MS);
    const jitter = Math.random() * Math.min(MAX_REFRESH_JITTER_IN_MS, wait / 2);
    const due =
      delayMs ?? Math.max(remaining <= 0 ? RETRY_REFRESH_MS : SECOND_IN_MS, wait - jitter);
    this.#timer = setTimeout(this.due, Math.min(due, MAX_TIMER_IN_MS));
    (this.#timer as { unref?: () => void }).unref?.();
  }

  get disposed(): boolean {
    return this.#disposed;
  }
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
  }
}
