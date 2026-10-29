import { tick } from "svelte";

import { request, pollDelay } from "../../updates/controller";
import { parsePending, type Pending } from "../controller";

type PollState = { offline: boolean; attempts: number; active: boolean };
type Options = {
  refresh: () => Promise<void>;
  pollState: () => PollState;
  tick: () => void;
};
const IDLE_POLL_MS = 8000;
const CLOCK_INTERVAL_MS = 1000;

/** Owns controller requests and timers for one mounted host console. */
export class HostConnection {
  alive = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private clock: ReturnType<typeof setInterval> | undefined;
  private readonly requests = new Set<AbortController>();
  constructor(private readonly options: Options) {}

  canPoll(polling: boolean, busy: boolean): boolean {
    return this.alive && polling === false && busy === false;
  }
  async call(body: object): Promise<Record<string, unknown>> {
    const abort = new AbortController();
    this.requests.add(abort);
    try {
      return await request(body, abort.signal);
    } finally {
      this.requests.delete(abort);
    }
  }
  pause(): void {
    clearTimeout(this.timer);
  }
  schedule(): void {
    this.pause();
    if (this.alive === false) return;
    const delayInMs = pollDelay({ ...this.options.pollState(), idleMs: IDLE_POLL_MS });
    // Hidden tabs keep their schedule without asking the controller.
    this.timer = setTimeout(() => {
      if (document.hidden) {
        this.schedule();
        return;
      }
      void this.options.refresh();
    }, delayInMs);
  }
  async focusReview(form: () => HTMLFormElement | undefined): Promise<void> {
    await tick();
    if (this.alive) {
      form()?.scrollIntoView({ behavior: "smooth", block: "start" });
      form()?.querySelector<HTMLElement>("h3")?.focus();
    }
  }
  readPending(key: string): Pending | null {
    try {
      return parsePending(JSON.parse(sessionStorage.getItem(key) ?? "null"));
    } catch {
      return null;
    }
  }
  mount(): () => void {
    this.clock = setInterval(this.options.tick, CLOCK_INTERVAL_MS);
    void this.options.refresh();
    const shown = () => {
      if (document.hidden === false) void this.options.refresh();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      this.alive = false;
      this.pause();
      clearInterval(this.clock);
      document.removeEventListener("visibilitychange", shown);
      for (const abort of this.requests) abort.abort();
    };
  }
}
