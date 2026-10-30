import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { requiredValue } from "./required-value.js";

/** Disposable PostgreSQL fixture URL. `NELCOTA_SSR_TEST_DATABASE_URL` is the neutral
 * name; `NELCOTA_NEXT_TEST_DATABASE_URL` is still accepted. */
export const testDatabaseUrl: string | undefined = [
  process.env["NELCOTA_SSR_TEST_DATABASE_URL"],
  process.env["NELCOTA_NEXT_TEST_DATABASE_URL"],
].find((value) => value !== undefined && value.trim() !== "");

interface PoolOptions {
  sizes: readonly number[];
  timeoutInMs: number;
  adminTimeoutInMs?: number;
}
/** Owns exactly one temporary database and its connection pools. */
export class PostgresDatabase {
  readonly name = `nelcota_next_test_${randomBytes(8).toString("hex")}`;
  readonly admin: Pool;
  readonly pools: Pool[];
  private created = false;
  constructor(options: PoolOptions) {
    // vitest.config.ts skips this suite locally without a URL and fails it in CI.
    const connectionString = requiredValue(
      testDatabaseUrl,
      "NELCOTA_SSR_TEST_DATABASE_URL for the disposable PostgreSQL fixture",
    );
    const url = new URL(connectionString);
    url.pathname = `/${this.name}`;
    this.admin = new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: options.adminTimeoutInMs ?? options.timeoutInMs,
    });
    this.pools = options.sizes.map(
      (max) =>
        new Pool({ connectionString: url.href, max, connectionTimeoutMillis: options.timeoutInMs }),
    );
    // Explicit listeners observe termination of idle sockets during fixture cleanup.
    for (const pool of [this.admin, ...this.pools]) pool.on("error", () => undefined);
  }
  async create(schema = true): Promise<void> {
    await this.admin.query(`CREATE DATABASE "${this.name}"`);
    this.created = true;
    if (schema)
      await requiredValue(this.pools[0], "database pool").query(
        await readFile(new URL("../sql/session-store.sql", import.meta.url), "utf8"),
      );
  }
  async dispose(): Promise<void> {
    // oxlint-disable-next-line no-await-in-loop -- Stop each owned pool before force-dropping its disposable database.
    for (const pool of this.pools) await pool.end();
    if (this.created) await this.admin.query(`DROP DATABASE "${this.name}" WITH (FORCE)`);
    await this.admin.end();
  }
}
