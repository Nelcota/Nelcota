/** A "copied" flag that clears itself; a later copy restarts its timer. */
export class CopyFeedback {
  copied = $state(false);
  private readonly durationInMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(durationInMs: number) {
    this.durationInMs = durationInMs;
  }

  /** Shows the outcome of one copy until the duration passes. */
  report(copied: boolean) {
    clearTimeout(this.timer);
    this.copied = copied;
    this.timer = setTimeout(() => (this.copied = false), this.durationInMs);
  }

  /** Stops a pending reset, for an owner that goes away before it fires. */
  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
