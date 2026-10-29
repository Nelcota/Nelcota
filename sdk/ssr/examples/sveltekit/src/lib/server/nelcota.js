// One integration per server process. Created on first use: SvelteKit imports
// server modules while building, when the runtime environment is not set.
import { createNelcotaSvelteKit } from "@nelcota/ssr/sveltekit";
import { DevelopmentSessionStore } from "@nelcota/ssr/testing";

/** @type {ReturnType<typeof createNelcotaSvelteKit> | undefined} */
let integration;

export function nelcota() {
  // adapter-node: read the runtime environment directly.
  const env = process.env;
  integration ??= createNelcotaSvelteKit({
    url: env.NELCOTA_URL ?? "",
    appOrigin: env.ORIGIN ?? "",
    keys: [env.NELCOTA_SESSION_KEY ?? ""],
    // Loopback development only. Production uses PostgresSessionStore from
    // '@nelcota/ssr/postgres' with the package's sql/session-store.sql schema.
    store: new DevelopmentSessionStore(),
    allowInsecureDevelopment: true,
  });
  return integration;
}
