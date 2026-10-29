import "server-only";
import { createNelcotaNext } from "@nelcota/nextjs/server";

import { options } from "./options";

let configured: ReturnType<typeof createNelcotaNext> | undefined;
export function nelcota(): ReturnType<typeof createNelcotaNext> {
  configured ??= createNelcotaNext(options());
  return configured;
}
