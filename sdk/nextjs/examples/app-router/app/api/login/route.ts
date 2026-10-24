import { nelcota } from '../../../lib/nelcota';
export async function POST(request: Request) {
  // Read the body before route(): the session lease must not wait on client I/O.
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('email' in body) || !('password' in body) || typeof body.email !== 'string' || typeof body.password !== 'string') return Response.json({ error: 'invalid_input' }, { status: 400 });
  const { email, password } = body;
  return (await nelcota()).route(request, async ({ auth }) => {
    const result = await auth.signInWithPassword({ email, password });
    return Response.json(result, { status: result.error ? 400 : 200 });
  });
}
