import 'server-only';
import { createNelcotaNext } from '@nelcota/nextjs/server';
import { DevelopmentSessionStore } from '@nelcota/nextjs/testing';

// Loopback fixture ONLY. Production must use PostgresSessionStore and HTTPS.
const store = new DevelopmentSessionStore();
let configured: ReturnType<typeof createNelcotaNext> | undefined;
export function nelcota(): ReturnType<typeof createNelcotaNext> {
  const url = process.env.NELCOTA_URL;
  const appOrigin = process.env.APP_ORIGIN;
  const key = process.env.NELCOTA_SESSION_KEY;
  if (!url || !appOrigin || !key) throw new Error('Configure server-side example environment');
  configured ??= createNelcotaNext({ url, appOrigin, keys: [key], store, allowInsecureDevelopment: true });
  return configured;
}
