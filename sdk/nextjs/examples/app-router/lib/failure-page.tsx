import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { ReactElement } from "react";

import { FAILURE_MESSAGES, sessionFailure } from "./session-errors";

/** Renders a generic page for a session failure; anything else reaches app/error.tsx. */
export function failurePage(error: unknown): ReactElement {
  unstable_rethrow(error);
  const failure = sessionFailure(error);
  if (failure === null) throw error;
  return (
    <main>
      <h1>{failure === "forbidden" ? "Request refused" : "Temporarily unavailable"}</h1>
      <p>{FAILURE_MESSAGES[failure]}</p>
    </main>
  );
}
