import { safeReturnTo } from "@nelcota/nextjs/server";

import { SignInForm } from "./form";
export const dynamic = "force-dynamic";
const DEFAULT_RETURN = "/profile";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  // The proxy sends `?next=` with the page that required a session; only a local path survives.
  const { next } = await searchParams;
  const target = typeof next === "string" ? safeReturnTo(next) : DEFAULT_RETURN;
  return (
    <main>
      <h1>Sign in</h1>
      <SignInForm next={target} />
    </main>
  );
}
