import { nelcota } from '#lib/server/nelcota.js';

export async function load(event) {
  // Rendering reads the verified identity and never refreshes the session.
  return (await nelcota()).server(event, async ({ getUser }) => ({ email: (await getUser()).data?.email ?? null }));
}
