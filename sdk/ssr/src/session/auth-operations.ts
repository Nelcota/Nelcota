import type { NelcotaClient, Result, Session, User } from "@nelcota/client";

import { HTTP_STATUS } from "../http/status.js";
import { identityOperation, mutationOptions } from "./mutation-options.js";
import { oauthOperations } from "./oauth.js";
import type { AuthOperations, MutationOptions } from "./types.js";
import type { WriteState } from "./write-state.js";

type SessionAuth = NelcotaClient["auth"];
function onlyUser(result: Result<Session>): Result<User> {
  return result.error != null ? result : { data: result.data.user, error: null };
}
function credentialOperations(
  state: WriteState,
  auth: SessionAuth,
): Pick<AuthOperations, "signInWithPassword" | "signUp" | "verifyEmailLink" | "resetPassword"> {
  return {
    signInWithPassword: async (input, options) => {
      state.mutate();
      return onlyUser(
        await identityOperation(state, () =>
          auth.signInWithPassword(input, mutationOptions(options)),
        ),
      );
    },
    signUp: async (input, options) => {
      state.mutate();
      const result = await identityOperation(state, () =>
        auth.signUp(input, mutationOptions(options)),
      );
      return result.error != null
        ? result
        : {
            data: {
              user: result.data.user,
              confirmationRequired: result.data.session === null,
            },
            error: null,
          };
    },
    verifyEmailLink: async (input, options) => {
      state.mutate();
      return onlyUser(
        await identityOperation(state, () => auth.verifyEmailLink(input, mutationOptions(options))),
      );
    },
    resetPassword: async (input, options) => {
      state.mutate();
      return onlyUser(
        await identityOperation(state, () => auth.resetPassword(input, mutationOptions(options))),
      );
    },
  };
}
function accountOperations(
  state: WriteState,
  auth: SessionAuth,
): Pick<
  AuthOperations,
  "getUser" | "updateUser" | "requestPasswordReset" | "sendMagicLink" | "resendConfirmation"
> {
  return {
    getUser: () => {
      state.mutate();
      return auth.getUser();
    },
    updateUser: (input, options) => {
      state.mutate();
      return auth.updateUser(input, mutationOptions(options));
    },
    requestPasswordReset: (email, options) => {
      state.mutate();
      return auth.requestPasswordReset(email, mutationOptions(options));
    },
    sendMagicLink: (email, options) => {
      state.mutate();
      return auth.sendMagicLink(email, mutationOptions(options));
    },
    resendConfirmation: (email, options) => {
      state.mutate();
      return auth.resendConfirmation(email, mutationOptions(options));
    },
  };
}
async function signOut(
  state: WriteState,
  auth: SessionAuth,
  options?: MutationOptions,
): ReturnType<AuthOperations["signOut"]> {
  state.mutate();
  const ending =
    state.state?.session != null ||
    state.loaded.superseded ||
    (state.input.presented &&
      (await state.records.head(state.lineage, undefined, state.lease)) !== null);
  const result = await auth.signOut(mutationOptions(options));
  if (ending) await state.publishGeneration();
  return result;
}
async function refresh(
  state: WriteState,
  auth: SessionAuth,
  options?: MutationOptions,
): ReturnType<AuthOperations["refresh"]> {
  state.mutate();
  const request = mutationOptions(options);
  const current = await auth.getSession(request);
  if (current.error != null) return current;
  if (current.data === null) return { data: null, error: null };
  let expiresAt = current.data.expires_at;
  let verified = await auth.getUser(request);
  if (
    verified.error?.status === HTTP_STATUS.unauthorized ||
    verified.error?.status === HTTP_STATUS.notFound
  ) {
    const renewed = await auth.refreshSession(request);
    if (renewed.error != null) return renewed;
    verified = await auth.getUser(request);
    expiresAt = renewed.data.expires_at;
  }
  if (verified.error != null) return verified;
  return { data: { user: verified.data, expiresAt }, error: null };
}

export function authOperations(
  state: WriteState,
  auth: SessionAuth,
  request: Request,
): AuthOperations {
  return {
    ...credentialOperations(state, auth),
    ...accountOperations(state, auth),
    ...oauthOperations(state, auth, request),
    signOut: (options) => signOut(state, auth, options),
    refresh: (options) => refresh(state, auth, options),
  };
}
