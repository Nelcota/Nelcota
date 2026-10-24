import { nelcota } from '../../../../lib/nelcota';
export async function POST(request: Request) {
  return (await nelcota()).route(request, async ({ auth }) => {
    const result = await auth.refresh();
    return Response.json(result, { status: result.error ? 401 : 200 });
  });
}
