import 'server-only';
import type { NextOptions } from '@nelcota/nextjs/server';
import { DevelopmentSessionStore } from '@nelcota/nextjs/testing';

// Loopback fixture ONLY. Production must use PostgresSessionStore and HTTPS.
// The proxy and the app are bundled separately; one process-wide store serves both.
const shared = globalThis as typeof globalThis & { nelcotaFixtureStore?: DevelopmentSessionStore };
export function options(): NextOptions {
  const url = process.env.NELCOTA_URL;
  const appOrigin = process.env.APP_ORIGIN;
  const key = process.env.NELCOTA_SESSION_KEY;
  if (!url || !appOrigin || !key) throw new Error('Configure server-side example environment');
  shared.nelcotaFixtureStore ??= new DevelopmentSessionStore();
  return { url, appOrigin, keys: [key], store: shared.nelcotaFixtureStore, allowInsecureDevelopment: true };
}
