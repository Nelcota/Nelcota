import type { NelcotaClient } from "@nelcota/client";

import { SessionError } from "../errors.js";
import { OAUTH_CALLBACK_PATH, safeReturnTo } from "../http/policy.js";
import { equalState } from "../sealing/crypto.js";
import { newSessionId, type SessionState } from "../sealing/seal.js";
import { mutationOptions } from "./mutation-options.js";
import type { AuthOperations } from "./types.js";
import type { WriteState } from "./write-state.js";

const SECOND_IN_MS = 1_000;
function matchingState(supplied: string | null, expected: string | null | undefined): boolean {
  if (supplied === null || supplied === "" || /^[A-Za-z0-9_-]{43}$/.test(supplied) === false)
    return false;
  if (expected == null || expected === "" || supplied.length !== expected.length) return false;
  return equalState(supplied, expected);
}
function callbackState(state: WriteState, request: Request): SessionState {
  state.ensure();
  if (state.input.callbackRequest === false)
    throw new SessionError("csrf", "Use the configured OAuth callback context");
  const supplied = new URL(request.url).searchParams.get("state");
  const expected = state.state?.oauthState;
  if (state.state === null || matchingState(supplied, expected) === false)
    throw new SessionError("csrf", "OAuth callback state did not match");
  return state.state;
}

export function oauthOperations(
  state: WriteState,
  auth: NelcotaClient["auth"],
  request: Request,
): Pick<AuthOperations, "startOAuth" | "exchangeCode"> {
  return {
    startOAuth: async (input) => {
      state.mutate();
      const config = state.records.config;
      const next: SessionState = {
        schema: 1,
        session: state.state?.session ?? null,
        pkce: null,
        oauthState: newSessionId(),
        returnTo: safeReturnTo(input.returnTo),
        expiresAt: state.state?.expiresAt ?? Date.now() + config.ttl * SECOND_IN_MS,
      };
      if (state.state?.generation !== undefined) next.generation = state.state.generation;
      // A sign-up awaiting its email link keeps its verifier.
      if (state.state?.signupPkce != null) next.signupPkce = state.state.signupPkce;
      await state.save(next);
      return await auth.signInWithOAuth({
        provider: input.provider,
        redirect: false,
        redirectTo: `${config.origin}${config.basePath}${OAUTH_CALLBACK_PATH}?state=${next.oauthState}`,
      });
    },
    exchangeCode: async (code, options) => {
      const current = callbackState(state, request);
      await state.save({ ...current, oauthState: null });
      const result = await state.identity(() => auth.exchangeCode(code, mutationOptions(options)));
      return result.error != null
        ? result
        : {
            data: { user: result.data.user, returnTo: safeReturnTo(state.state?.returnTo) },
            error: null,
          };
    },
  };
}
