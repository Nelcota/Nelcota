import { nelcota } from "../../../lib/nelcota";
const HTTP_BAD_REQUEST = 400;
const HTTP_OK = 200;

export async function POST(request: Request) {
  // Read the body before route(): the session lease must not wait on client I/O.
  const body: unknown = await request.json().catch(() => null);
  if (
    body === null ||
    typeof body !== "object" ||
    "email" in body === false ||
    "password" in body === false ||
    typeof body.email !== "string" ||
    typeof body.password !== "string"
  )
    return Response.json({ error: "invalid_input" }, { status: 400 });
  const { email, password } = body;
  return await (
    await nelcota()
  ).route(request, async ({ auth }) => {
    const result = await auth.signInWithPassword({ email, password });
    return Response.json(result, { status: result.error !== null ? HTTP_BAD_REQUEST : HTTP_OK });
  });
}
