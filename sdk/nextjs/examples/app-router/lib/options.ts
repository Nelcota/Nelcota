import "server-only";
import { PostgresSessionStore } from "@nelcota/nextjs/postgres";
import type { NextOptions } from "@nelcota/nextjs/server";
import { DevelopmentSessionStore } from "@nelcota/nextjs/testing";
import { Pool } from "pg";

// Loopback fixture ONLY. Production must use PostgresSessionStore and HTTPS.
// The proxy and the app are bundled separately; one process-wide store serves both.
const shared = globalThis as typeof globalThis & {
  nelcotaFixtureStore?: DevelopmentSessionStore;
  nelcotaFixturePool?: Pool;
};
export function options(): NextOptions {
  const { url, appOrigin, key } = exampleEnvironment();
  const connectionString = process.env.NELCOTA_NEXT_SESSION_DATABASE_URL;
  if (connectionString != null && connectionString !== "") {
    if (shared.nelcotaFixturePool == null) {
      shared.nelcotaFixturePool = new Pool({
        connectionString,
        max: 8,
        connectionTimeoutMillis: 2000,
        query_timeout: 5000,
      });
      shared.nelcotaFixturePool.on("error", observePoolError);
    }
    return {
      url,
      appOrigin,
      keys: [key],
      store: new PostgresSessionStore(shared.nelcotaFixturePool),
      allowInsecureDevelopment: true,
    };
  }
  shared.nelcotaFixtureStore ??= new DevelopmentSessionStore();
  return {
    url,
    appOrigin,
    keys: [key],
    store: shared.nelcotaFixtureStore,
    allowInsecureDevelopment: true,
  };
}

function observePoolError(): void {
  // Do not include connection details or credentials in application logs.
  console.error("Example session database connection failed");
}

function exampleEnvironment(): { url: string; appOrigin: string; key: string } {
  const url = process.env.NELCOTA_URL;
  const appOrigin = process.env.APP_ORIGIN;
  const key = process.env.NELCOTA_SESSION_KEY;
  if (
    url == null ||
    url === "" ||
    appOrigin == null ||
    appOrigin === "" ||
    key == null ||
    key === ""
  )
    throw new Error("Configure server-side example environment");
  return { url, appOrigin, key };
}
