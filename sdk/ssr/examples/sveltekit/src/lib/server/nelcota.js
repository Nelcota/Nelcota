// One integration per server process. Created on first use: SvelteKit imports
// server modules while building, when the runtime environment is not set.
import { createNelcotaSvelteKit } from "@nelcota/ssr/sveltekit";

const SESSION_POOL_SIZE = 8;

/** @type {ReturnType<typeof createNelcotaSvelteKit> | undefined} */
let integration;

export function nelcota() {
  integration ??= create();
  return integration;
}

async function create() {
  // adapter-node: read the runtime environment directly.
  const env = process.env;
  const appOrigin = env.ORIGIN ?? "";
  // Plain-HTTP loopback origins are development; any other origin gets the
  // production checks, which refuse the in-memory store.
  const loopback = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(appOrigin);
  return await createNelcotaSvelteKit({
    url: env.NELCOTA_URL ?? "",
    appOrigin,
    keys: [env.NELCOTA_SESSION_KEY ?? ""],
    store: await sessionStore(env.NELCOTA_SESSION_DATABASE_URL),
    allowInsecureDevelopment: loopback,
  });
}

/** Production: PostgreSQL provisioned with the package's sql/session-store.sql.
 * Without a database URL: the in-memory store, accepted only for loopback HTTP.
 * @param {string | undefined} connectionString
 * @returns {Promise<import("@nelcota/ssr").SessionStore>} */
async function sessionStore(connectionString) {
  if (connectionString === undefined || connectionString === "") {
    const { DevelopmentSessionStore } = await import("@nelcota/ssr/testing");
    return new DevelopmentSessionStore();
  }
  const [{ default: pg }, { PostgresSessionStore }] = await Promise.all([
    import("pg"),
    import("@nelcota/ssr/postgres"),
  ]);
  return new PostgresSessionStore(new pg.Pool({ connectionString, max: SESSION_POOL_SIZE }));
}
