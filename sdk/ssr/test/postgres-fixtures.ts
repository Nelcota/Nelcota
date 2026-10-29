import { EventEmitter } from "node:events";

import { vi } from "vitest";

import { promiseResult } from "../src/lifecycle/promise-result.js";
import { type SessionConnection } from "../src/postgres.js";

const key = "a".repeat(64);

const value = () => ({ sealed: "encrypted-fixture", expiresAt: Date.now() + 60000 });

function queryRows(sql: string, allowUnlock = true): Record<string, unknown>[] {
  if (sql.includes("current_setting")) return [{ timeout: "0" }];
  if (allowUnlock && sql.includes("unlock")) return [{ released: true }];
  return sql.includes("try_advisory_lock") ? [{ locked: true }] : [];
}

const lockOnly = (sql: string) => promiseResult(() => ({ rows: queryRows(sql, false) }));

function fixture() {
  const query = vi.fn<SessionConnection["query"]>((sql) =>
    promiseResult(() => ({
      rows: queryRows(sql),
    })),
  );
  const release = vi.fn<SessionConnection["release"]>();
  const events = new EventEmitter();
  const on = events.on.bind(events),
    removeListener = events.removeListener.bind(events);
  const pool = {
    connect: vi.fn(() => promiseResult(() => ({ query, release, on, removeListener }))),
  };
  return { pool, query, release, on, removeListener, events };
}
export { key, value, queryRows, lockOnly, fixture };
