import "server-only";
import { createNelcotaNext, type NextIntegration } from "@nelcota/nextjs/server";

import { options } from "./options";

// Created on first use, never at module load. A failed configuration is not cached,
// so the next request retries instead of replaying the same rejection forever.
let configured: Promise<NextIntegration<unknown>> | undefined;
export async function nelcota(): Promise<NextIntegration<unknown>> {
  configured ??= options()
    .then(async (selected) => await createNelcotaNext(selected))
    .catch((error: unknown) => {
      configured = undefined;
      throw error;
    });
  return await configured;
}
