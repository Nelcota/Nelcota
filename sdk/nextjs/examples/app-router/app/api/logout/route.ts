import { nelcota } from "../../../lib/nelcota";
const HTTP_BAD_REQUEST = 400;
const HTTP_OK = 200;

export async function POST(request: Request) {
  return await (
    await nelcota()
  ).route(request, async ({ auth }) => {
    const result = await auth.signOut();
    return Response.json(result, { status: result.error != null ? HTTP_BAD_REQUEST : HTTP_OK });
  });
}
