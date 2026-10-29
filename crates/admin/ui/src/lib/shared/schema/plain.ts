// Plain-language reading of access rules (D93): what a table's grants and
// policies mean for the people using the app. The technical form (RLS, roles,
// SQL) stays one click away.

/** What a role may do with a table, from its grants. */
export type Access = "none" | "read" | "full" | "partial";

/** The verbs of a partial access, in a stable order. */
export type Verb = "read" | "create" | "edit" | "delete";

const VERBS: Record<string, Verb> = {
  SELECT: "read",
  INSERT: "create",
  UPDATE: "edit",
  DELETE: "delete",
};
const ORDER: Verb[] = ["read", "create", "edit", "delete"];

export function access(grants: readonly string[]): { level: Access; verbs: Verb[] } {
  const verbs = ORDER.filter((verb) => grants.some((grant) => VERBS[grant.toUpperCase()] === verb));
  if (verbs.length === 0) return { level: "none", verbs };
  if (verbs.length === ORDER.length) return { level: "full", verbs };
  if (verbs.length === 1 && verbs[0] === "read") return { level: "read", verbs };
  return { level: "partial", verbs };
}

/** The kinds of policy the panel can put into words. */
export type PolicyMeaning =
  | { kind: "everyoneReads" }
  | { kind: "signedInReads" }
  | { kind: "owner"; command: "select" | "insert" | "update" | "delete" | "all"; column: string }
  | { kind: "custom" };

interface PolicyShape {
  command: string;
  roles: readonly string[];
  using: string | null;
  check: string | null;
}

/** `true`, as Postgres prints it back (possibly in parentheses). */
const isTrue = (expr: string | null) => expr !== null && /^\(*\s*true\s*\)*$/i.test(expr);

/** The column compared with `auth.uid()`, in either order and with Postgres' parentheses. */
export function ownerColumn(expr: string | null): string | null {
  if (expr === null) return null;
  const inner = expr
    .trim()
    .replace(/^\((.*)\)$/s, "$1")
    .trim();
  const column = String.raw`"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*)`;
  const uid = String.raw`\(\s*select\s+auth\.uid\(\)\s+as\s+uid\s*\)|auth\.uid\(\)`;
  const left = new RegExp(String.raw`^(?:${column})\s*=\s*(?:${uid})$`, "i").exec(inner);
  const right = new RegExp(String.raw`^(?:${uid})\s*=\s*(?:${column})$`, "i").exec(inner);
  const match = left ?? right;
  if (match == null) return null;
  return match[1] !== undefined ? match[1].replaceAll('""', '"') : (match[2] ?? null);
}

type PolicyAudience = "everyone" | "signedIn" | "other";
function policyAudience(values: readonly string[]): PolicyAudience {
  const roles = values.map((role) => role.toLowerCase());
  if (roles.length === 0 || roles.includes("public") || roles.includes("anon")) return "everyone";
  return roles.length === 1 && roles[0] === "authenticated" ? "signedIn" : "other";
}
function readMeaning(audience: PolicyAudience): PolicyMeaning {
  if (audience === "everyone") return { kind: "everyoneReads" };
  return audience === "signedIn" ? { kind: "signedInReads" } : { kind: "custom" };
}
function ownerMeaning(policy: PolicyShape, command: string): PolicyMeaning {
  const using = ownerColumn(policy.using);
  const check = ownerColumn(policy.check);
  const column = using ?? check;
  const consistent =
    column !== null &&
    (policy.using === null || using === column) &&
    (policy.check === null || check === column) &&
    (command === "insert" ? check !== null : using !== null);
  if (consistent)
    return {
      kind: "owner",
      command: command as "select" | "insert" | "update" | "delete" | "all",
      column,
    };
  return { kind: "custom" };
}
export function describePolicy(policy: PolicyShape): PolicyMeaning {
  const command = policy.command.toLowerCase();
  // No role listed means PUBLIC: everyone, signed in or not.
  const audience = policyAudience(policy.roles);
  if (command === "select" && isTrue(policy.using) && policy.check === null)
    return readMeaning(audience);
  if (audience === "signedIn" && ["select", "insert", "update", "delete", "all"].includes(command))
    return ownerMeaning(policy, command);
  return { kind: "custom" };
}
