// Hidden grid columns, remembered per table in this browser.

import { readJson, write } from "$lib/browser/local-storage";

const key = (table: string) => `nelcota:hidden-columns:${table}`;
const parse = (data: unknown): string[] | null =>
  Array.isArray(data) ? data.filter((c): c is string => typeof c === "string") : null;

export class HiddenColumns {
  names = $state<string[]>([]);
  #table = "";

  /** Switches to another table's preferences. */
  load(table: string) {
    this.#table = table;
    this.names = readJson(key(table), parse, []);
  }

  has(column: string) {
    return this.names.includes(column);
  }

  hide(column: string) {
    if (this.has(column) === false) this.set([...this.names, column]);
  }

  show(column: string) {
    this.set(this.names.filter((c) => c !== column));
  }

  toggle(column: string) {
    if (this.has(column)) {
      this.show(column);
      return;
    }
    this.hide(column);
  }

  showAll() {
    this.set([]);
  }

  /** Forgets columns that no longer exist (renamed or dropped). */
  prune(existing: readonly string[]) {
    const kept = this.names.filter((c) => existing.includes(c));
    if (kept.length !== this.names.length) this.set(kept);
  }

  private set(names: string[]) {
    this.names = names;
    if (this.#table !== "") write(key(this.#table), JSON.stringify(names));
  }
}
