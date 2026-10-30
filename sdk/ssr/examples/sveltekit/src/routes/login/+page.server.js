import { safeReturnTo } from "@nelcota/ssr";
import { fail, redirect } from "@sveltejs/kit";

import { nelcota } from "#lib/server/nelcota.js";
const HTTP_SEE_OTHER = 303;
const HTTP_BAD_REQUEST = 400;

/** @satisfies {import("@sveltejs/kit").Actions} */
export const actions = {
  default: async (event) => {
    const form = await event.request.formData();
    const sessions = await nelcota();
    const result = await sessions.action(event, ({ auth }) =>
      auth.signInWithPassword({
        email: formText(form, "email"),
        password: formText(form, "password"),
      }),
    );
    if (result.error !== null)
      return fail(HTTP_BAD_REQUEST, { error: "Invalid email or password" });
    // The guard writes `next` with paths.base already included.
    redirect(
      HTTP_SEE_OTHER,
      safeReturnTo(event.url.searchParams.get("next") ?? `${sessions.basePath}/dashboard`),
    );
  },
};

/** @param {FormData} form
 * @param {string} name
 * @returns {string} */
function formText(form, name) {
  const value = form.get(name);
  if (typeof value === "string") return value;
  throw new TypeError(`Expected text for ${name}`);
}
