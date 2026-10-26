import { redirect } from '@sveltejs/kit';
import { nelcota } from '#lib/server/nelcota.js';

export const actions = {
  default: async event => {
    await (await nelcota()).action(event, ({ auth }) => auth.signOut());
    redirect(303, '/login');
  },
};
