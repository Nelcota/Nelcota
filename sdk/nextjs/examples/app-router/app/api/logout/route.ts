import { nelcota } from '../../../lib/nelcota';
export async function POST(request: Request) {
  return (await nelcota()).route(request, async ({ auth }) => {
    const result = await auth.signOut();
    return Response.json(result, { status: result.error ? 400 : 200 });
  });
}
