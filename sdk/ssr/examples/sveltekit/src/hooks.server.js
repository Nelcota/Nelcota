import { nelcota } from "#lib/server/nelcota.js";

/** @type {import('@nelcota/ssr/sveltekit').SvelteKitHandle | undefined} */
let guard;

/** @type {import('@sveltejs/kit/hooks').Handle} */
export async function handle(input) {
  guard ??= (await nelcota()).handle({ protectedPaths: ["/dashboard"] });
  return await guard(input);
}
