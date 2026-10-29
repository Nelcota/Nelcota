import { nelcota } from "#lib/server/nelcota.js";

/** @param {import("@sveltejs/kit").RequestEvent} event */
export async function load(event) {
  // Rendering reads the verified identity and never refreshes the session.
  return await (
    await nelcota()
  ).server(event, async ({ getUser }) => ({
    email: (await getUser()).data?.email ?? null,
  }));
}
