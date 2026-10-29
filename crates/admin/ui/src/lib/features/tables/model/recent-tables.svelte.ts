import { readJson, readText, remove, write } from "$lib/browser/local-storage";
import { untrack } from "svelte";

import { parseRecent, rememberRecent } from "../home.js";
const RECENT_TABLES = "nelcota:tables-recent";
const LAST_TABLE = "nelcota:tables-last";

/** Migrates the legacy last-table preference once and keeps recent names in memory. */
export class RecentTables {
  names = $state<string[]>([]);
  constructor() {
    const legacy = readText(LAST_TABLE, "");
    this.names = readJson(RECENT_TABLES, parseRecent, legacy.trim() === "" ? [] : [legacy]);
    if (legacy.trim() !== "") {
      write(RECENT_TABLES, JSON.stringify(this.names));
      remove(LAST_TABLE);
    }
  }
  remember(name: string): void {
    this.names = rememberRecent(
      untrack(() => this.names),
      name,
    );
    write(RECENT_TABLES, JSON.stringify(this.names));
  }
}
