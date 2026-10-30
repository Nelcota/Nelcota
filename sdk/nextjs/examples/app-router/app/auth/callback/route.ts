import { safeReturnTo } from "@nelcota/nextjs/server";

import { nelcota } from "../../../lib/nelcota";
const HTTP_SEE_OTHER = 303;

export async function GET(request: Request) {
  return await (
    await nelcota()
  ).callback(request, async ({ auth }) => {
    const result = await auth.exchangeCode(new URL(request.url).searchParams.get("code") ?? "");
    if (result.error != null) return Response.json({ error: "sign_in_failed" }, { status: 400 });
    // A validated local path as a relative Location: the browser resolves it against
    // the origin it actually requested, so neither environment values nor Host
    // headers decide where the visitor lands. (From 0.2.0 the integration also
    // exposes its validated `origin` and `basePath` for absolute URLs.)
    return new Response(null, {
      status: HTTP_SEE_OTHER,
      headers: { location: safeReturnTo(result.data.returnTo) },
    });
  });
}
