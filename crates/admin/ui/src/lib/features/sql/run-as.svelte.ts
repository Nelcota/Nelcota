// Who the SQL editor runs as (D94). Not persisted on purpose: a reload goes
// back to the database owner, so nobody forgets they are testing as someone.

import type { RunAsMode, RunAsUser, Viewer } from "$lib/shared/run-as";

export type { RunAsMode, RunAsUser };

/** The `run_as` field of `POST /admin/api/sql`. */
export type RunAsRequest =
  | { role: "owner" }
  | { role: "anon" }
  | { role: "authenticated"; user_id: string };

export const runAs = $state<Viewer>({ mode: "owner", user: null });

export function setRunAs(mode: "owner" | "anon"): void;
export function setRunAs(mode: "authenticated", user: RunAsUser): void;
export function setRunAs(mode: RunAsMode, user: RunAsUser | null = null) {
  runAs.mode = mode;
  runAs.user = mode === "authenticated" ? user : null;
}

export function runAsRequest(): RunAsRequest {
  if (runAs.mode === "authenticated") {
    // Falling back to the owner here would skip the access rules unnoticed.
    if (runAs.user === null) throw new Error("run as a signed-in user without a user");
    return { role: "authenticated", user_id: runAs.user.id };
  }
  return { role: runAs.mode === "anon" ? "anon" : "owner" };
}
