import { fail, redirect } from '@sveltejs/kit';
import { safeReturnTo } from '@nelcota/ssr';
import { nelcota } from '#lib/server/nelcota.js';

export const actions = {
  default: async event => {
    const form = await event.request.formData();
    const result = await (await nelcota()).action(event, ({ auth }) =>
      auth.signInWithPassword({ email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') }));
    if (result.error) return fail(400, { error: 'Invalid email or password' });
    redirect(303, safeReturnTo(event.url.searchParams.get('next') ?? '/dashboard'));
  },
};
