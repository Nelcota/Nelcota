import type { Result } from "@nelcota/client";
import type { AuthOperations } from "@nelcota/nextjs/server";

import { nelcota } from "../../../lib/nelcota";
const HTTP_BAD_REQUEST = 400;
const HTTP_OK = 200;

// Email-link credentials are submitted in a POST body, never reflected into a
// redirect or response. Production applications should add their own form UX.
export async function POST(request: Request) {
  const value: unknown = await request.json().catch(() => null);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return Response.json({ error: "invalid_input" }, { status: 400 });
  const body = value as Record<string, unknown>;
  return await (
    await nelcota()
  ).route(request, async ({ auth }) => {
    const result = await runOperation(auth, body);
    if (result === null) return Response.json({ error: "invalid_input" }, { status: 400 });
    return Response.json(result, { status: result.error !== null ? HTTP_BAD_REQUEST : HTTP_OK });
  });
}

function inputText(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}
function runOperation(
  auth: AuthOperations,
  body: Record<string, unknown>,
): Promise<Result<unknown> | null> {
  const text = (key: string): string => inputText(body, key);
  switch (body["operation"]) {
    case "signup":
      return auth.signUp({ email: text("email"), password: text("password") });
    case "refresh":
      return auth.refresh();
    case "update":
      return auth.updateUser({ data: { display_name: text("displayName") } });
    case "oauth":
      return auth.startOAuth({
        provider: "github",
        returnTo: text("returnTo") === "" ? "/profile" : text("returnTo"),
      });
    default:
      return emailOperation(auth, body);
  }
}
function emailOperation(
  auth: AuthOperations,
  body: Record<string, unknown>,
): Promise<Result<unknown> | null> {
  const text = (key: string): string => inputText(body, key);
  switch (body["operation"]) {
    case "recover":
      return auth.requestPasswordReset(text("email"));
    case "magiclink":
      return auth.sendMagicLink(text("email"));
    case "resend":
      return auth.resendConfirmation(text("email"));
    case "verify": {
      const type = body["type"];
      if (type !== "signup" && type !== "magiclink") return Promise.resolve(null);
      return auth.verifyEmailLink({ type, token: text("token") });
    }
    case "reset":
      return auth.resetPassword({ token: text("token"), password: text("password") });
    default:
      return Promise.resolve(null);
  }
}
