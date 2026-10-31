import { safeReturnTo } from "@nelcota/ssr";
import { redirect } from "@sveltejs/kit";

import { nelcota } from "#lib/server/nelcota.js";
const HTTP_SEE_OTHER = 303;

// The guard sends a browser whose access token expired here. Rendering never
// refreshes, so the page POSTs back and this action rotates the session.
/** @satisfies {import("@sveltejs/kit").Actions} */
export const actions = {
  default: async (event) => {
    const sessions = await nelcota();
    // `next` comes from the guard, base path included.
    const next = safeReturnTo(event.url.searchParams.get("next") ?? `${sessions.basePath}/`);
    const result = await sessions.action(event, ({ auth }) => auth.refresh());
    if (result.error !== null || result.data === null)
      redirect(HTTP_SEE_OTHER, `${sessions.basePath}/login?next=${encodeURIComponent(next)}`);
    redirect(HTTP_SEE_OTHER, next);
  },
};
