// The first things a new project needs, read from the overview. Each step is
// done when the project shows it, never by a click, so the list stays true.
import type { Overview } from "$lib/contracts/types";

type StepId = "table" | "protect" | "user" | "connect";

export interface Step {
  id: StepId;
  done: boolean;
  /** Where the step is done. */
  path: string;
}

export function nextSteps(overview: Overview): Step[] {
  const tables = overview.tables.filter((table) => table.kind === "table");
  const unprotected = overview.tables.some(
    (table) => table.rls.state === "danger" || table.rls.state === "warn",
  );
  return [
    { id: "table", done: tables.length > 0, path: "/tables?create=true" },
    { id: "protect", done: tables.length > 0 && Boolean(unprotected) === false, path: "/policies" },
    { id: "user", done: overview.counts.users > 0, path: "/users" },
    // Observe API sign-in separately from the application data-access verification.
    { id: "connect", done: overview.counts.signed_in_users > 0, path: "/connect" },
  ];
}

/** Tables that need action now, most serious first. */
export function attention(overview: Overview) {
  const pick = (state: string) =>
    overview.tables.filter((table) => table.rls.state === state).map((table) => table.name);
  return { exposed: pick("danger"), locked: pick("warn") };
}
