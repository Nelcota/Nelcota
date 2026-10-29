// A readable name for an unsaved query, from what it does: "Query on orders"
// reads better in a list than "select round(mean_exec_time::nu".

export type QueryTitle =
  | { kind: "read" | "insert" | "update" | "delete" | "create" | "alter" | "drop"; target: string }
  | { kind: "empty" }
  | { kind: "other" };

const IDENT = String.raw`((?:"(?:[^"]|"")+"|[a-z_][\w$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-z_][\w$]*))?)`;

const PATTERNS: [QueryTitle["kind"], RegExp][] = [
  [
    "create",
    new RegExp(
      String.raw`^create\s+(?:or\s+replace\s+)?(?:unlogged\s+)?(?:table|view|materialized\s+view|function|index\s+\S+\s+on)\s+(?:if\s+not\s+exists\s+)?${IDENT}`,
      "i",
    ),
  ],
  ["alter", new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${IDENT}`, "i")],
  [
    "drop",
    new RegExp(String.raw`^drop\s+(?:table|view|function)\s+(?:if\s+exists\s+)?${IDENT}`, "i"),
  ],
  ["insert", new RegExp(String.raw`^insert\s+into\s+${IDENT}`, "i")],
  ["update", new RegExp(String.raw`^update\s+(?:only\s+)?${IDENT}`, "i")],
  ["delete", new RegExp(String.raw`^delete\s+from\s+(?:only\s+)?${IDENT}`, "i")],
  ["read", new RegExp(String.raw`\bfrom\s+${IDENT}`, "i")],
];

/** Strips comments and leading `with ... as (...)` noise enough to read the main statement. */
function firstStatement(sql: string): string {
  const [first = ""] = sql
    .replaceAll(/--[^\n]*/g, " ")
    .replaceAll(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .split(";");
  return first.replaceAll(/\s+/g, " ").trim();
}

/** Shows `"Name"` and `schema.table` as people write them, minus the public schema. */
function readable(target: string): string {
  return target
    .replaceAll(/\s*\.\s*/g, ".")
    .replace(/^public\./i, "")
    .replaceAll('""', '"');
}

export function queryTitle(sql: string): QueryTitle {
  const statement = firstStatement(sql);
  if (statement === "") return { kind: "empty" };
  for (const [kind, pattern] of PATTERNS) {
    const match = pattern.exec(statement);
    if (match?.[1] !== undefined) return { kind, target: readable(match[1]) };
  }
  return { kind: "other" };
}
