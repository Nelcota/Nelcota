import { describe, expect, it } from "vitest";

import {
  alignRight,
  canonicalType,
  cellPreview,
  CELL_PREVIEW_MAX_LENGTH,
  compactJsonPreview,
  columnKind,
  shortUuid,
  columnWidth,
  editedValue,
  monospace,
  nextCell,
  pageInfo,
} from "./grid";

const col = (
  name: string,
  type: string,
  extra: {
    enum_values?: string[];
    is_pk?: boolean;
    full_type?: string;
    references?: { table: string; column: string };
  } = {},
) => ({
  name,
  type,
  full_type: extra.full_type ?? type,
  references: extra.references ?? null,
  enum_values: extra.enum_values ?? [],
  is_pk: extra.is_pk ?? false,
});

describe("column kind", () => {
  it.each(["__proto__", "constructor"])(
    "keeps the custom PostgreSQL type %s instead of an inherited alias",
    (type) => {
      expect(canonicalType(type)).toBe(type);
      expect(columnKind(col("custom", type))).toBe("text");
      expect(columnKind(col("custom", type, { enum_values: ["open", "closed"] }))).toBe("enum");
    },
  );

  it("from the Postgres type (format_type name)", () => {
    expect(columnKind(col("a", "numeric"))).toBe("number");
    expect(columnKind(col("a", "bigint"))).toBe("number");
    expect(columnKind(col("a", "boolean"))).toBe("boolean");
    expect(columnKind(col("a", "timestamp with time zone"))).toBe("temporal");
    expect(columnKind(col("a", "jsonb"))).toBe("json");
    expect(columnKind(col("a", "uuid"))).toBe("uuid");
    expect(columnKind(col("a", "text"))).toBe("text");
    expect(columnKind(col("a", "character varying"))).toBe("text");
  });

  it("also from the short aliases", () => {
    expect(columnKind(col("a", "timestamptz"))).toBe("temporal");
    expect(columnKind(col("a", "int8"))).toBe("number");
    expect(columnKind(col("a", "bool"))).toBe("boolean");
    expect(canonicalType("timestamp")).toBe("timestamp without time zone");
    expect(canonicalType("citext")).toBe("citext");
  });

  it("shortens canonical UUIDs only", () => {
    expect(shortUuid("0f8e3c2a-1b2c-4d5e-8f90-9b1d4e7f6a10")).toBe("0f8e3c2a…6a10");
    expect(shortUuid("not-a-uuid")).toBe("not-a-uuid");
    expect(columnWidth(col("id", "uuid", { is_pk: true }))).toBeLessThan(200);
  });

  it("enum wins over the type", () => {
    expect(columnKind(col("a", "order_status", { enum_values: ["open", "paid"] }))).toBe("enum");
  });

  it("arrays stay text even when their elements are enums", () => {
    for (const type of ["order_status[]", "public.order_status[]"]) {
      expect(columnKind(col("a", type, { enum_values: ["open", "paid"] }))).toBe("text");
    }
    for (const type of ["numeric[]", "boolean[]", "jsonb[]", "text[]"]) {
      expect(columnKind(col("a", type))).toBe("text");
    }
  });
});

describe("width and alignment", () => {
  it("width by type, without clipping the name in the header", () => {
    // A numeric PK is narrow, but leaves room for the name, the type and the column menu.
    const id = columnWidth(col("id", "bigint", { is_pk: true }));
    expect(id).toBeGreaterThanOrEqual(Math.ceil("bigint".length * 6.8 + 72));
    expect(id).toBeLessThan(columnWidth(col("description", "text")));
    expect(columnWidth(col("done", "boolean"))).toBeGreaterThanOrEqual(104);
    expect(columnWidth(col("a_rather_long_column_name", "boolean"))).toBeGreaterThan(104);
    expect(columnWidth(col("x".repeat(80), "text"))).toBe(420);
  });

  it("the type line fits too (full type and the foreign key table)", () => {
    const fk = col("customer_id", "bigint", { references: { table: "customers", column: "id" } });
    expect(columnWidth(fk)).toBeGreaterThanOrEqual(
      Math.ceil("bigint → customers".length * 6.8 + 72),
    );
    const numeric = col("total", "numeric", { full_type: "numeric(10,2)" });
    expect(columnWidth(numeric)).toBeGreaterThanOrEqual(
      Math.ceil("numeric(10,2)".length * 6.8 + 72),
    );
    expect(columnWidth(col("created_at", "timestamp with time zone"))).toBeGreaterThanOrEqual(188);
  });

  it("numbers right-aligned and mono; text in the regular font", () => {
    expect(alignRight("number")).toBe(true);
    expect(alignRight("text")).toBe(false);
    expect(monospace("number")).toBe(true);
    expect(monospace("text")).toBe(false);
    expect(monospace("enum")).toBe(false);
  });
});

describe("pagination", () => {
  it("range and page count with an exact total", () => {
    expect(pageInfo({ page: 0, size: 50, rowsOnPage: 40, total: 40, exact: true })).toEqual({
      from: 1,
      to: 40,
      lastPage: 0,
      pageCount: 1,
    });
    expect(pageInfo({ page: 2, size: 25, rowsOnPage: 25, total: 120, exact: true })).toEqual({
      from: 51,
      to: 75,
      lastPage: 4,
      pageCount: 5,
    });
  });

  it("an estimated or unknown total does not guess the last page", () => {
    expect(pageInfo({ page: 1, size: 50, rowsOnPage: 50, total: 12000, exact: false })).toEqual({
      from: 51,
      to: 100,
      lastPage: null,
      pageCount: null,
    });
    expect(
      pageInfo({ page: 0, size: 50, rowsOnPage: 10, total: null, exact: false }).lastPage,
    ).toBeNull();
  });

  it("no rows", () => {
    expect(pageInfo({ page: 0, size: 50, rowsOnPage: 0, total: 0, exact: true })).toEqual({
      from: 0,
      to: 0,
      lastPage: 0,
      pageCount: 1,
    });
  });
});

describe("keyboard navigation", () => {
  const at = (row: number, col: number) => ({ row, col });

  it("arrows move one cell and stop at the edges", () => {
    expect(nextCell("ArrowDown", at(0, 0), { rows: 5, cols: 3 })).toEqual(at(1, 0));
    expect(nextCell("ArrowRight", at(0, 2), { rows: 5, cols: 3 })).toEqual(at(0, 2));
    expect(nextCell("ArrowUp", at(0, 1), { rows: 5, cols: 3 })).toEqual(at(0, 1));
    expect(nextCell("ArrowLeft", at(3, 0), { rows: 5, cols: 3 })).toEqual(at(3, 0));
  });

  it("Home/End within the row; with Ctrl, first/last cell", () => {
    expect(nextCell("Home", at(2, 2), { rows: 5, cols: 3 })).toEqual(at(2, 0));
    expect(nextCell("End", at(2, 0), { rows: 5, cols: 3 })).toEqual(at(2, 2));
    expect(nextCell("Home", at(4, 2), { rows: 5, cols: 3, ctrl: true })).toEqual(at(0, 0));
    expect(nextCell("End", at(0, 0), { rows: 5, cols: 3, ctrl: true })).toEqual(at(4, 2));
  });

  it("PageUp/PageDown jump 10 rows without going past the edge", () => {
    expect(nextCell("PageDown", at(0, 1), { rows: 25, cols: 3 })).toEqual(at(10, 1));
    expect(nextCell("PageDown", at(20, 1), { rows: 25, cols: 3 })).toEqual(at(24, 1));
    expect(nextCell("PageUp", at(5, 1), { rows: 25, cols: 3 })).toEqual(at(0, 1));
  });

  it("other keys and an empty grid do not move", () => {
    expect(nextCell("a", at(0, 0), { rows: 5, cols: 3 })).toBeNull();
    expect(nextCell("ArrowDown", at(0, 0), { rows: 0, cols: 3 })).toBeNull();
  });
});

describe("inline edit value", () => {
  it("an untouched NULL cell stays NULL", () => {
    expect(editedValue(null, "")).toBeUndefined();
  });

  it("an unchanged value is not saved", () => {
    expect(editedValue("abc", "abc")).toBeUndefined();
    expect(editedValue("", "")).toBeUndefined();
  });

  it("a changed value is saved as typed", () => {
    expect(editedValue(null, "42")).toBe("42");
    expect(editedValue("abc", "")).toBe("");
    expect(editedValue("abc", "abd")).toBe("abd");
  });

  it("setting NULL is saved only when the cell was not NULL", () => {
    expect(editedValue("abc", "abc", true)).toBeNull();
    expect(editedValue(null, "", true)).toBeUndefined();
  });
});

describe("cell previews", () => {
  it("keeps short values whole and cuts long ones at the limit with an ellipsis", () => {
    expect(cellPreview("short")).toBe("short");
    const exact = "a".repeat(CELL_PREVIEW_MAX_LENGTH);
    expect(cellPreview(exact)).toBe(exact);
    const long = cellPreview("b".repeat(CELL_PREVIEW_MAX_LENGTH * 10));
    expect(long).toHaveLength(CELL_PREVIEW_MAX_LENGTH + 1);
    expect(long.endsWith("…")).toBe(true);
  });

  it("never splits an astral character at the cut", () => {
    const text = `${"a".repeat(CELL_PREVIEW_MAX_LENGTH - 1)}\u{1F600}tail`;
    expect(cellPreview(text)).toBe(`${"a".repeat(CELL_PREVIEW_MAX_LENGTH - 1)}…`);
  });

  it("compacts JSON onto one line and cuts large documents", () => {
    expect(compactJsonPreview('{ "a": [1, 2] }')).toBe('{"a":[1,2]}');
    expect(compactJsonPreview("not json")).toBe("not json");
    const large = JSON.stringify(
      { items: Array.from({ length: 1000 }, (_, index) => index) },
      null,
      2,
    );
    expect(compactJsonPreview(large)).toHaveLength(CELL_PREVIEW_MAX_LENGTH + 1);
  });
  it("keeps every digit and the whitespace inside strings", () => {
    expect(
      compactJsonPreview('{ "id": 12345678901234567890, "amount": 0.10000000000000000001 }'),
    ).toBe('{"id":12345678901234567890,"amount":0.10000000000000000001}');
    expect(compactJsonPreview('{ "note": "two  spaces\\n \\" quoted \\"" }')).toBe(
      '{"note":"two  spaces\\n \\" quoted \\""}',
    );
    expect(compactJsonPreview('"plain  string"')).toBe('"plain  string"');
  });
  it("cuts a very large value without parsing all of it", () => {
    const huge = `[${" 1,".repeat(100_000)} 1]`;
    expect(huge.length).toBeGreaterThan(64 * 1024);
    expect(compactJsonPreview(huge)).toBe(
      `${`[${"1,".repeat(CELL_PREVIEW_MAX_LENGTH)}`.slice(0, CELL_PREVIEW_MAX_LENGTH)}…`,
    );
    expect(compactJsonPreview(`text ${"x".repeat(70_000)}`)).toHaveLength(
      CELL_PREVIEW_MAX_LENGTH + 1,
    );
  });
});
