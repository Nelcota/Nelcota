import { redirect } from '@sveltejs/kit';
import { safeReturnTo } from '@nelcota/ssr';
import { nelcota } from '#lib/server/nelcota.js';

// The guard sends a browser whose access token expired here. Rendering never
// refreshes, so the page POSTs back and this action rotates the session.
export const actions = {
  default: async event => {
    const next = safeReturnTo(event.url.searchParams.get('next') ?? '/');
    const result = await (await nelcota()).action(event, ({ auth }) => auth.refresh());
    if (result.error || !result.data) redirect(303, `/login?next=${encodeURIComponent(next)}`);
    redirect(303, next);
  },
};
