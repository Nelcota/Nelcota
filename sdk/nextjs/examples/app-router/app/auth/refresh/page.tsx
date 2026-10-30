import { safeReturnTo } from "@nelcota/nextjs/server";

import { Continue } from "./continue";
export const dynamic = "force-dynamic";
const DEFAULT_RETURN = "/profile";

export default async function Refresh({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  // The proxy names the page that needs a renewed session; only a local path survives.
  const { next } = await searchParams;
  return (
    <main>
      <h1>Continue your session</h1>
      <p>Renew the session before returning to the page you opened.</p>
      <Continue next={typeof next === "string" ? safeReturnTo(next) : DEFAULT_RETURN} />
    </main>
  );
}
