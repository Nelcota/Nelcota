// SQL preview while a form changes. The server is the only source of the
// generated SQL (the same functions that execute it): the interface does not
// reimplement any rule. Rapid requests are debounced and the previous one is
// cancelled.

import { errorMessage } from "$lib/i18n/index.svelte";
import { isAbort } from "$lib/transport/api";

import type { DdlResult } from "./ddl";

const DELAY_MS = 350;

export class SqlPreview {
  sql = $state<string[] | null>(null);
  error = $state("");
  loading = $state(false);

  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;

  /** Schedules the preview; `request` gets the signal so it can be cancelled. */
  schedule(request: (signal: AbortSignal) => Promise<DdlResult>) {
    this.clear();
    this.loading = true;
    this.#timer = setTimeout(() => this.#run(request), DELAY_MS);
  }

  async #run(request: (signal: AbortSignal) => Promise<DdlResult>) {
    this.#timer = undefined;
    this.#controller?.abort();
    const controller = (this.#controller = new AbortController());
    this.loading = true;
    try {
      const result = await request(controller.signal);
      if (this.#controller !== controller || controller.signal.aborted) return;
      this.sql = result.sql;
      this.error = "";
    } catch (e) {
      if (this.#controller !== controller || controller.signal.aborted || isAbort(e)) return;
      this.sql = null;
      this.error = errorMessage(e);
    } finally {
      if (this.#controller === controller) {
        this.loading = false;
        this.#controller = undefined;
      }
    }
  }

  /** Clears (e.g. an incomplete form) and cancels anything pending. */
  clear() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    this.sql = null;
    this.error = "";
    this.loading = false;
  }
}
