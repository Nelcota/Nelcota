// How grid columns are presented by Postgres type: category, width and
// alignment. Pure, so it can be tested without mounting a component.

import type { Column, RowData } from "$lib/contracts/types";

const HIGH_SURROGATE = { start: 0xd800, end: 0xdbff } as const;
const UUID_PREVIEW = { start: 8, end: 4 } as const;
const COLUMN_WIDTH = {
  nameCharacter: 7.5,
  typeCharacter: 6.8,
  primaryKeyPadding: 88,
  padding: 72,
  minimum: 96,
  number: 128,
  maximum: 420,
} as const;

/**
 * Longest text a cell keeps in the DOM for its tooltip or JSON preview. A
 * cell shows only its start; the detail dialog has the whole value.
 */
export const CELL_PREVIEW_MAX_LENGTH = 500;

export function cellPreview(text: string): string {
  if (text.length <= CELL_PREVIEW_MAX_LENGTH) return text;
  // Do not split a surrogate pair (emoji and other astral characters).
  const lastCode = text.charCodeAt(CELL_PREVIEW_MAX_LENGTH - 1);
  const end =
    lastCode >= HIGH_SURROGATE.start && lastCode <= HIGH_SURROGATE.end
      ? CELL_PREVIEW_MAX_LENGTH - 1
      : CELL_PREVIEW_MAX_LENGTH;
  return `${text.slice(0, end)}…`;
}

/** Above this, a value is not parsed just to check it is JSON. */
const JSON_VALIDATION_MAX_LENGTH = 65_536;
const JSON_CONTAINER_START = /^\s*[[{]/;

/**
 * JSON on a single line, cut for the cell; text that is not JSON is only cut.
 * Whitespace outside strings is dropped instead of re-serializing, so numbers
 * keep every digit and a large value is only read up to the preview length.
 */
export function compactJsonPreview(text: string): string {
  if (isJsonText(text) === false) return cellPreview(text);
  return cellPreview(withoutJsonWhitespace(text, CELL_PREVIEW_MAX_LENGTH + 1));
}

function isJsonText(text: string): boolean {
  if (text.length > JSON_VALIDATION_MAX_LENGTH) return JSON_CONTAINER_START.test(text);
  try {
    JSON.parse(text);
    return true;
  } catch {
    // Not JSON: the caller shows the text as stored.
    return false;
  }
}

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** Drops whitespace outside strings, stopping once `limit` characters are kept. */
type JsonTextState = "plain" | "quoted" | "escaped";
function quotedState(state: JsonTextState, character: string): JsonTextState {
  if (state === "escaped") return "quoted";
  if (character === "\\") return "escaped";
  return character === '"' ? "plain" : "quoted";
}
function withoutJsonWhitespace(text: string, limit: number): string {
  let kept = "";
  let state: JsonTextState = "plain";
  for (const character of text) {
    if (kept.length >= limit) break;
    if (state !== "plain") {
      kept += character;
      state = quotedState(state, character);
      continue;
    }
    if (JSON_WHITESPACE.has(character)) continue;
    if (character === '"') state = "quoted";
    kept += character;
  }
  return kept;
}

/** Stable identity, including composite keys; never use a row's position for writes. */
export function rowKey(row: RowData, primaryKey: readonly string[], fallback = 0): string {
  return primaryKey.length > 0
    ? JSON.stringify(primaryKey.map((key) => row[key]))
    : String(fallback);
}

export function rowPk(row: RowData, primaryKey: readonly string[]): RowData {
  return Object.fromEntries(primaryKey.map((key) => [key, row[key] ?? null]));
}

export type ColumnKind = "number" | "boolean" | "temporal" | "json" | "uuid" | "enum" | "text";

const NUMBER = new Set(["smallint", "integer", "bigint", "numeric", "real", "double precision"]);
const TEMPORAL = new Set([
  "timestamp with time zone",
  "timestamp without time zone",
  "date",
  "time without time zone",
  "time with time zone",
  "interval",
]);

// Short names Postgres also accepts (and `pg_type.typname` uses). The catalog
// sends `format_type` names, but a type written by hand or a mock may not.
const ALIASES: Record<string, string> = {
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  int2: "smallint",
  int4: "integer",
  int: "integer",
  int8: "bigint",
  float4: "real",
  float8: "double precision",
  decimal: "numeric",
  bool: "boolean",
};

/** The `format_type` name of a Postgres type, also from its short alias. */
export function canonicalType(type: string): string {
  return Object.hasOwn(ALIASES, type) ? (ALIASES[type] ?? type) : type;
}

export function columnKind(column: Pick<Column, "type" | "enum_values">): ColumnKind {
  const type = canonicalType(column.type);
  // Enum metadata describes the elements; the editor needs the whole array literal.
  if (type.endsWith("[]")) return "text";
  if (column.enum_values.length > 0) return "enum";
  if (NUMBER.has(type)) return "number";
  if (type === "boolean") return "boolean";
  if (TEMPORAL.has(type)) return "temporal";
  if (type === "json" || type === "jsonb") return "json";
  if (type === "uuid") return "uuid";
  return "text";
}

/**
 * Initial width (px). Fixed per column: with `table-layout: fixed`, editing a
 * cell does not resize the other columns.
 */
export function columnWidth(
  column: Pick<Column, "name" | "type" | "enum_values" | "is_pk" | "full_type" | "references">,
): number {
  const kind = columnKind(column);
  // The header has to fit: the name (regular font) and the type line (small
  // mono, with the foreign key's table). Average widths per character.
  const typeLabel =
    column.full_type + (column.references != null ? ` → ${column.references.table}` : "");
  const header = Math.max(
    column.name.length * COLUMN_WIDTH.nameCharacter +
      (column.is_pk ? COLUMN_WIDTH.primaryKeyPadding : COLUMN_WIDTH.padding),
    typeLabel.length * COLUMN_WIDTH.typeCharacter + COLUMN_WIDTH.padding,
    COLUMN_WIDTH.minimum,
  );
  const base: Record<ColumnKind, number> = {
    number: column.is_pk ? COLUMN_WIDTH.minimum : COLUMN_WIDTH.number,
    boolean: 104,
    temporal: 188,
    json: 260,
    // Shown shortened (`shortUuid`); the full value is on hover, copy and edit.
    uuid: 150,
    enum: 140,
    text: 220,
  };
  return Math.ceil(Math.min(Math.max(base[kind], header), COLUMN_WIDTH.maximum));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `0f8e3c2a-…-9b1d4e7f6a10` → `0f8e3c2a…6a10`: the start and the end tell rows
 * apart (random and sequential ids alike) in a third of the width. Anything
 * that is not a canonical UUID comes back unchanged.
 */
export function shortUuid(value: string): string {
  return UUID.test(value)
    ? `${value.slice(0, UUID_PREVIEW.start)}…${value.slice(-UUID_PREVIEW.end)}`
    : value;
}

/** Numbers on the right (to compare magnitudes); everything else on the left. */
export const alignRight = (kind: ColumnKind) => kind === "number";

/** Mono font only where it helps reading (numbers, ids, JSON); text in the regular font. */
export const monospace = (kind: ColumnKind) =>
  kind === "number" || kind === "uuid" || kind === "json";

export interface PageInfo {
  /** First and last row shown (1-based); 0 and 0 without rows. */
  from: number;
  to: number;
  /** Last page (0-based), only with an exact total; `null` when unknown. */
  lastPage: number | null;
  pageCount: number | null;
}

/** Row range and page count for the grid footer. */
export function pageInfo({
  page,
  size,
  rowsOnPage,
  total,
  exact,
}: {
  page: number;
  size: number;
  rowsOnPage: number;
  total: number | null;
  exact: boolean;
}): PageInfo {
  const from = rowsOnPage !== 0 && Number.isNaN(rowsOnPage) === false ? page * size + 1 : 0;
  const to = rowsOnPage !== 0 && Number.isNaN(rowsOnPage) === false ? page * size + rowsOnPage : 0;
  if (total === null || exact === false) return { from, to, lastPage: null, pageCount: null };
  const pageCount = Math.max(1, Math.ceil(total / size));
  return { from, to, lastPage: pageCount - 1, pageCount };
}

export interface CellPos {
  row: number;
  col: number;
}

const PAGE_ROWS = 10;
const CELL_MOVES: ReadonlyMap<string, CellPos> = new Map([
  ["ArrowUp", { row: -1, col: 0 }],
  ["ArrowDown", { row: 1, col: 0 }],
  ["ArrowLeft", { row: 0, col: -1 }],
  ["ArrowRight", { row: 0, col: 1 }],
  ["PageUp", { row: -PAGE_ROWS, col: 0 }],
  ["PageDown", { row: PAGE_ROWS, col: 0 }],
]);

/**
 * Keyboard navigation in the grid (WAI-ARIA "grid" pattern): arrows, Home/End
 * (with Ctrl, first/last cell) and PageUp/PageDown. `null` for keys that do
 * not move. Always within bounds.
 */
export function nextCell(
  key: string,
  pos: CellPos,
  { rows, cols, ctrl = false }: { rows: number; cols: number; ctrl?: boolean | undefined },
): CellPos | null {
  if (rows === 0 || cols === 0) return null;
  const clamp = (row: number, col: number) => ({
    row: Math.min(Math.max(row, 0), rows - 1),
    col: Math.min(Math.max(col, 0), cols - 1),
  });
  const move = CELL_MOVES.get(key);
  if (move !== undefined) return clamp(pos.row + move.row, pos.col + move.col);
  if (key === "Home") return ctrl ? clamp(0, 0) : clamp(pos.row, 0);
  if (key === "End") return ctrl ? clamp(rows - 1, cols - 1) : clamp(pos.row, cols - 1);
  return null;
}

/**
 * The value an inline edit should store, or `undefined` when nothing changed.
 * Opening a NULL cell shows an empty draft; leaving it empty keeps the NULL
 * instead of writing '' (which also fails on numeric and date columns).
 */
export function editedValue(
  original: string | null,
  draft: string,
  asNull = false,
): string | null | undefined {
  if (asNull) return original === null ? undefined : null;
  if (original === null && draft === "") return undefined;
  return draft === original ? undefined : draft;
}

export type { Column, RowData, TableData } from "$lib/contracts/types";
