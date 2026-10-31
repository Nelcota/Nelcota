import { redirect } from "@sveltejs/kit";

import { nelcota } from "#lib/server/nelcota.js";
const HTTP_SEE_OTHER = 303;

/** @satisfies {import("@sveltejs/kit").Actions} */
export const actions = {
  default: async (event) => {
    const sessions = await nelcota();
    await sessions.action(event, ({ auth }) => auth.signOut());
    redirect(HTTP_SEE_OTHER, `${sessions.basePath}/login`);
  },
};
