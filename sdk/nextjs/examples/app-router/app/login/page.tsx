import { redirect } from "next/navigation";

import { nelcota } from "../../lib/nelcota";
export const dynamic = "force-dynamic";
async function signIn(form: FormData) {
  "use server";
  const email = form.get("email"),
    password = form.get("password");
  if (typeof email !== "string" || typeof password !== "string") return;
  await (
    await nelcota()
  ).action(async ({ auth }) => {
    const result = await auth.signInWithPassword({ email, password });
    if (result.error != null) throw new Error("Sign in failed");
    redirect("/profile");
  });
}
export default function Login() {
  return (
    <main>
      <h1>Sign in</h1>
      <form action={signIn}>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <button>Sign in</button>
      </form>
    </main>
  );
}
