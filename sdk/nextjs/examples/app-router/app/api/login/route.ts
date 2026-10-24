import { nelcota } from '../../../lib/nelcota';
export async function POST(request: Request) {
  return (await nelcota()).route(request, async ({ auth }) => {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('email' in body) || !('password' in body) || typeof body.email !== 'string' || typeof body.password !== 'string') return Response.json({ error: 'invalid_input' }, { status: 400 });
    const result = await auth.signInWithPassword({ email: body.email, password: body.password });
    return Response.json(result, { status: result.error ? 400 : 200 });
  });
}
