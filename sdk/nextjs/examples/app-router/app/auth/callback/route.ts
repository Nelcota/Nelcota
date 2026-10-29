import { safeReturnTo } from "@nelcota/nextjs/server";

import { nelcota } from "../../../lib/nelcota";
const HTTP_SEE_OTHER = 303;

export async function GET(request: Request) {
  return await (
    await nelcota()
  ).callback(request, async ({ auth }) => {
    const result = await auth.exchangeCode(new URL(request.url).searchParams.get("code") ?? "");
    if (result.error != null) return Response.json({ error: "sign_in_failed" }, { status: 400 });
    return Response.redirect(
      new URL(safeReturnTo(result.data.returnTo), process.env.APP_ORIGIN),
      HTTP_SEE_OTHER,
    );
  });
}
