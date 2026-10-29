import { requiredValue } from "../../contracts/required-value.js";
import {
  blankColumn,
  type ColumnDef,
  type CreateTable,
  type PolicyDef,
  type Privilege,
} from "./ddl";
import { quoteIfNeeded } from "./ident";
const MAX_IDENTIFIER_BYTES = 63;

export type Audience = "private" | "owner" | "signedIn" | "everyone";
export type AccessLevel = "read" | "full";
export const SIMPLE_TYPES = [
  "text",
  "bigint",
  "numeric",
  "boolean",
  "date",
  "timestamptz",
  "uuid",
  "jsonb",
] as const;
export type SimpleType = (typeof SIMPLE_TYPES)[number];

export function nameProblem(name: string): "required" | "long" | "invalid" | null {
  const trimmed = name.trim();
  if (trimmed === "") return "required";
  if (new TextEncoder().encode(trimmed).length > MAX_IDENTIFIER_BYTES) return "long";
  if (trimmed.includes("\0")) return "invalid";
  return null;
}

export function columnProblem(columns: readonly ColumnDef[], index: number) {
  const problem = nameProblem(requiredValue(columns[index], "bounded operation item").name);
  if (problem != null) return problem;
  if (
    columns.some(
      (column, other) =>
        other !== index &&
        column.name.trim() === requiredValue(columns[index], "bounded operation item").name.trim(),
    )
  )
    return "duplicate";
  return null;
}

export function guidedPolicy(
  audience: Audience,
  level: AccessLevel,
  { column = "user_id", name }: { column?: string | undefined; name?: string | undefined } = {},
): PolicyDef | null {
  if (audience === "private") return null;
  const read = level === "read" || audience === "everyone";
  const expression = audience === "owner" ? `${quoteIfNeeded(column)} = auth.uid()` : "true";
  return {
    name: name ?? `${policyPrefix(audience)}_${read ? "read" : "all"}`,
    command: read ? "select" : "all",
    roles: policyRoles(audience),
    permissive: true,
    using: expression,
    check: read ? null : expression,
  };
}

export function uniquePolicyName(name: string, existing: readonly string[]): string {
  if (existing.includes(name) === false) return name;
  let index = 2;
  while (existing.includes(`${name}_${index}`)) index++;
  return `${name}_${index}`;
}

export function initialTable(): CreateTable {
  return {
    name: "",
    comment: null,
    rls: true,
    columns: [
      {
        ...blankColumn(),
        name: "id",
        data_type: "bigint",
        primary_key: true,
        identity: true,
        nullable: false,
      },
      {
        ...blankColumn(),
        name: "created_at",
        data_type: "timestamptz",
        default: "now()",
        nullable: false,
      },
      blankColumn(),
    ],
    grants: [{ role: "service_role", privileges: ["select", "insert", "update", "delete"] }],
  };
}

/** Build a complete table request without mutating the draft. */
export function tableAccess(draft: CreateTable, audience: Audience, level: AccessLevel) {
  const table = structuredClone(draft);
  table.name = table.name.trim();
  for (const column of table.columns) column.name = column.name.trim();
  const policy = guidedPolicy(audience, level);
  if (audience === "owner") ensureOwnerColumn(table.columns);
  const privileges: Privilege[] =
    level === "full" && audience !== "everyone"
      ? ["select", "insert", "update", "delete"]
      : ["select"];
  table.rls = true;
  table.grants = [
    { role: "anon", privileges: audience === "everyone" ? ["select"] : [] },
    { role: "authenticated", privileges: audience === "private" ? [] : privileges },
    { role: "service_role", privileges: ["select", "insert", "update", "delete"] },
  ];
  return { table, policies: policy != null ? [policy] : [] };
}

export const automaticColumn = (column: ColumnDef) =>
  (column.name === "id" && column.identity) ||
  (column.name === "created_at" && column.default === "now()");

function policyPrefix(audience: Audience): string {
  if (audience === "signedIn") return "signed_in";
  return audience === "everyone" ? "public" : "owner";
}

function policyRoles(audience: Audience): PolicyDef["roles"] {
  return audience === "everyone" ? ["anon", "authenticated"] : ["authenticated"];
}
function ensureOwnerColumn(columns: ColumnDef[]): void {
  const column = columns.find((entry) => entry.name === "user_id");
  if (column != null && column.data_type !== "uuid") throw new Error("owner_column_type");
  if (column != null) {
    column.default = "auth.uid()";
    column.nullable = false;
    return;
  }
  columns.push({
    ...blankColumn(),
    name: "user_id",
    data_type: "uuid",
    nullable: false,
    default: "auth.uid()",
  });
}
