/**
 * A behavioral port of the server's parsing of `in` lists and or/and
 * operands (crates/api/src/query/parse.rs: parse_in_list, split_top_level,
 * unquote_operand), so property tests can check the client's encoding
 * against the reading the server will do. The contract tests check the same
 * against the real binary.
 */

export { parseInList } from "./grammar/in-list.js";
export { splitTopLevel } from "./grammar/top-level.js";

/** `column.op."value"` → `[column, op, value]` as the server reads it. */
export function readFilter(item: string): [string, string, string] {
  const dot = item.indexOf(".");
  const column = item.slice(0, dot);
  const filter = item.slice(dot + 1);
  const opDot = filter.indexOf(".");
  const op = filter.slice(0, opDot);
  const operand = filter.slice(opDot + 1);
  if (op === "in" || operand.startsWith('"') === false) return [column, op, operand];
  if (operand.endsWith('"') === false || operand.length < 2) throw new Error("unclosed quotes");
  let value = "";
  const chars = operand.slice(1, -1);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "\\") {
      const next = chars[++i];
      value += next ?? "";
      continue;
    }
    value += chars[i];
  }
  return [column, op, value];
}
