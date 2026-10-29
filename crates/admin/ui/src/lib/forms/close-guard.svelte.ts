import { beforeNavigate } from "$lib/navigation/router.svelte";

interface CloseGuardOptions {
  dirty: () => boolean;
  busy: () => boolean;
  close: () => void;
  active: () => boolean;
}

/** Guard user-initiated closing; successful saves can close directly. */
export class CloseGuard {
  pending = $state(false);
  private proceed: (() => void) | null = null;
  private waiting = $state(false);

  private readonly dirty: () => boolean;
  private readonly busy: () => boolean;
  private readonly close: () => void;

  constructor({ dirty, busy, close, active }: CloseGuardOptions) {
    this.dirty = dirty;
    this.busy = busy;
    this.close = close;
    $effect(() => {
      if (active() === false) return;
      return beforeNavigate({
        blocked: () => active() && (this.busy() || this.dirty()),
        request: (proceed) => {
          this.proceed = proceed;
          if (this.busy()) {
            this.waiting = true;
            return;
          }
          this.pending = true;
        },
      });
    });
    $effect(() => {
      if (this.waiting === false || this.busy()) return;
      this.waiting = false;
      if (active() && this.dirty()) {
        this.pending = true;
        return;
      }
      const proceed = this.proceed;
      this.proceed = null;
      proceed?.();
    });
  }

  request = () => {
    if (this.busy()) return;
    this.proceed = null;
    if (this.dirty()) {
      this.pending = true;
      return;
    }
    this.close();
  };

  discard = () => {
    const proceed = this.proceed;
    this.proceed = null;
    this.pending = false;
    this.close();
    proceed?.();
  };

  change = (next: boolean) => {
    if (next === false) this.request();
  };
}
