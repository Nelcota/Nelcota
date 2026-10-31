import { clientError, fail, ok, type Result } from "../core/client.errors.js";
import type { HttpClient } from "../core/http/client.js";
/**
 * Email-link verification and the sign-up's PKCE verifier: bound to the
 * confirmation link at sign-up and sent back when that link is verified, so
 * the chosen password survives. Storage that cannot keep it (an adapter
 * refusing the key) leaves the link unbound instead of failing.
 */
import type { SessionManager } from "./lifecycle/manager.js";
import { challengeFor, createVerifier } from "./pkce.js";
import { isSession, type Session } from "./session.js";
import type { AuthRequestOptions } from "./types.js";

interface LinkAuth {
  http: HttpClient;
  manager: SessionManager;
}

/** Stores a new sign-up verifier and returns its challenge; `null` when storage refused it. */
export async function bindSignup(manager: SessionManager): Promise<string | null> {
  // Stored before the request: a lost answer may still have sent the link.
  const verifier = createVerifier();
  const stored = await manager
    .withVerifier(() => manager.setVerifier(verifier, "signup"))
    .then(
      () => true,
      () => false,
    );
  return stored ? await challengeFor(verifier) : null;
}

/** Removes the verifier; a failed removal leaves a harmless verifier and never a lost session. */
export function forgetSignup(manager: SessionManager): Promise<unknown> {
  return manager.withVerifier(() => manager.consumeVerifier("signup")).catch(() => null);
}

/**
 * `POST /auth/v1/verify` as a sign-in. A `signup` link carries the stored
 * verifier, held under the verifier lock as for an OAuth exchange (a new
 * sign-up cannot replace it until the answer is known); only a session
 * removes it, so a failure keeps it for a retry.
 */
export function verifyLink(
  { http, manager }: LinkAuth,
  body: Record<string, string>,
  options: AuthRequestOptions,
): Promise<Result<Session>> {
  const post = async (sent: Record<string, string>): Promise<Result<Session>> => {
    const result = await http.json<unknown>({
      method: "POST",
      path: "/auth/v1/verify",
      json: sent,
      auth: false,
      signal: options.signal,
      timeout: options.timeout,
    });
    if (result.error != null) return fail(result.error);
    if (isSession(result.data)) return ok(result.data);
    return fail(clientError("invalid_response", "Invalid auth response"));
  };
  const confirm = () =>
    manager.withVerifier(async () => {
      const verifier = await manager.peekVerifier("signup").catch(() => null);
      if (verifier == null || verifier === "") return await post(body);
      const result = await post({ ...body, code_verifier: verifier });
      if (result.error == null) await manager.consumeVerifier("signup").catch(() => null);
      return result;
    });
  return manager.authenticate(
    () => (body["type"] === "signup" ? confirm() : post(body)),
    options.signal,
  );
}
