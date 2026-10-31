"use client";
import { useActionState } from "react";

import { signIn, type SignInState } from "./actions";

const initial: SignInState = { error: null };
export function SignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signIn, initial);
  return (
    <form action={action}>
      <input type="hidden" name="next" value={next} />
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button disabled={pending}>Sign in</button>
      <p role="alert">{state.error}</p>
    </form>
  );
}
