import { nelcota } from "../../../../lib/nelcota";
const HTTP_UNAUTHORIZED = 401;
const HTTP_OK = 200;

export async function POST(request: Request) {
  return await (
    await nelcota()
  ).route(request, async ({ auth }) => {
    const result = await auth.refresh();
    return Response.json(result, { status: result.error != null ? HTTP_UNAUTHORIZED : HTTP_OK });
  });
}
