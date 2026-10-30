"use server";
import { safeReturnTo } from "@nelcota/nextjs/server";
import { redirect, unstable_rethrow } from "next/navigation";

import { nelcota } from "../../lib/nelcota";
import { FAILURE_MESSAGES, sessionFailure } from "../../lib/session-errors";

export interface SignInState {
  error: string | null;
}
const INVALID = "Invalid email or password.";

export async function signIn(_previous: SignInState, form: FormData): Promise<SignInState> {
  const email = form.get("email"),
    password = form.get("password"),
    // The return path arrives from the browser: validate it again here.
    next = safeReturnTo(form.get("next"));
  if (typeof email !== "string" || typeof password !== "string") return { error: INVALID };
  try {
    return await (
      await nelcota()
    ).action(async ({ auth }) => {
      const result = await auth.signInWithPassword({ email, password });
      // One generic message: never reveal whether the account exists.
      if (result.error != null) return { error: INVALID };
      // Throws to redirect; the adapter publishes the accepted cookie first.
      redirect(next);
    });
  } catch (error) {
    unstable_rethrow(error); // Next redirects are not authentication failures.
    const failure = sessionFailure(error);
    if (failure === null) throw error;
    return { error: FAILURE_MESSAGES[failure] };
  }
}
