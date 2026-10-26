/** When the next background refresh is due. It owns the timer, not what the refresh does. */
import { secondsLeft, type Session } from './session.js';

export const RETRY_REFRESH_MS = 10_000;
// First retry after an uncertain refresh: the server only takes the old token back within 10 s.
export const QUICK_RETRY_REFRESH_MS = 2_000;

export class RefreshScheduler {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(readonly enabled: boolean, private readonly margin: (session: Session) => number, private readonly due: () => void) {}

  /** Replaces any pending refresh; `null` (or a disabled scheduler) leaves none. */
  schedule(session: Session | null, delayMs?: number): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#disposed || !this.enabled || !session) return;
    const remaining = secondsLeft(session);
    const wait = Math.max(0, (remaining - this.margin(session)) * 1000);
    const jitter = Math.random() * Math.min(5000, wait / 2);
    const due = delayMs ?? Math.max(remaining <= 0 ? RETRY_REFRESH_MS : 1000, wait - jitter);
    this.#timer = setTimeout(this.due, Math.min(due, 2 ** 31 - 1));
    (this.#timer as { unref?: () => void }).unref?.();
  }

  get disposed(): boolean { return this.#disposed; }
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
  }
}
