// Who a read acts as, shared by the SQL editor (D94) and the table view:
// the database owner (no rules), a visitor (`anon`) or a real signed-in user.

export type RunAsMode = "owner" | "anon" | "authenticated";

export interface RunAsUser {
  id: string;
  email: string;
}

export interface Viewer {
  mode: RunAsMode;
  user: RunAsUser | null;
}

/** Texts of the picker, so each feature words it for what it does. */
export interface RunAsLabels {
  label: string;
  owner: string;
  ownerHint: string;
  anon: string;
  anonHint: string;
  authenticated: string;
  authenticatedHint: string;
  asVisitor: string;
  asUser: (email: string) => string;
  /** The trigger while acting as the owner. */
  ownerTrigger: string;
  ownerTriggerMore?: string;
  ownerTriggerTitle?: string;
  pickTitle: string;
  search: string;
  empty: string;
  noUsers: string;
  loading: string;
}
