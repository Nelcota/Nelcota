import { nelcota } from '../../../lib/nelcota';

// Email-link credentials are submitted in a POST body, never reflected into a
// redirect or response. Production applications should add their own form UX.
export async function POST(request: Request) {
  const value: unknown = await request.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Response.json({ error: 'invalid_input' }, { status: 400 });
  const body = value as Record<string, unknown>;
  const text = (key: string): string => typeof body[key] === 'string' ? body[key] : '';
  return (await nelcota()).route(request, async ({ auth }) => {
    const run = async () => {
      switch (body['operation']) {
        case 'signup': return auth.signUp({ email: text('email'), password: text('password') });
        case 'refresh': return auth.refresh();
        case 'update': return auth.updateUser({ data: { display_name: text('displayName') } });
        case 'recover': return auth.requestPasswordReset(text('email'));
        case 'magiclink': return auth.sendMagicLink(text('email'));
        case 'resend': return auth.resendConfirmation(text('email'));
        case 'verify': {
          if (body['type'] !== 'signup' && body['type'] !== 'magiclink') return null;
          return auth.verifyEmailLink({ type: body['type'], token: text('token') });
        }
        case 'reset': return auth.resetPassword({ token: text('token'), password: text('password') });
        case 'oauth': return auth.startOAuth({ provider: 'github', returnTo: text('returnTo') || '/profile' });
        default: return null;
      }
    };
    const result = await run();
    if (result === null) return Response.json({ error: 'invalid_input' }, { status: 400 });
    return Response.json(result, { status: result.error ? 400 : 200 });
  });
}
