import { describe, expect, it } from "vitest";

import { requiredValue } from "../../contracts/required-value.js";
import {
  columnWidthCss,
  columnWidths,
  DETAIL_TEXT_LIMIT,
  MAX_COLUMN_CHARS,
  needsDetail,
} from "./result-layout";

const chars = (columns: string[], rows: (string | null)[][]) =>
  columnWidths(columns, rows).map((width) => width.chars);

it("SQL result column widths: fits the header or the longest value of each column", () => {
  expect(
    chars(
      ["id", "description"],
      [
        ["1", "short"],
        ["12345", "a much longer description"],
      ],
    ),
  ).toEqual([5, 25]);
});

it("SQL result column widths: counts NULL by its label and keeps a minimum width", () => {
  expect(chars(["a", "b"], [[null, ""]])).toEqual([4, 4]);
});

it("SQL result column widths: uses only the headers when there are no rows", () => {
  expect(columnWidths(["created_at"], [])).toEqual([{ chars: 10, detail: false }]);
});

it("SQL result column widths: caps long values, which the cell truncates", () => {
  expect(chars(["body"], [["x".repeat(5000)]])).toEqual([MAX_COLUMN_CHARS]);
  expect(chars(["h".repeat(200)], [])).toEqual([MAX_COLUMN_CHARS]);
});

it("SQL result column widths: tolerates a row shorter than the column list", () => {
  expect(chars(["a", "missing"], [["value"]])).toEqual([5, 7]);
});

it("SQL result column widths: makes room for the details button when any value needs it", () => {
  const widths = columnWidths(
    ["note", "id"],
    [
      ["a\nb", "1"],
      ["ok", "2"],
    ],
  );
  expect(widths).toEqual([
    { chars: 4, detail: true },
    { chars: 4, detail: false },
  ]);
  expect(columnWidthCss(requiredValue(widths[0], "test fixture item"))).toBe(
    "min(24rem, calc(4ch + 1.5rem + 1px + 2.25rem))",
  );
  expect(columnWidthCss(requiredValue(widths[1], "test fixture item"))).toBe(
    "min(24rem, calc(4ch + 1.5rem + 1px))",
  );
});

it("SQL result column widths: still finds a details value after the width reached its cap", () => {
  const rows = [["x".repeat(MAX_COLUMN_CHARS)], ["short"], ["two\nlines"]];
  expect(columnWidths(["text"], rows)).toEqual([{ chars: MAX_COLUMN_CHARS, detail: true }]);
});

describe("SQL cell details", () => {
  it("offers the full text only for long or multi-line values", () => {
    expect(needsDetail(null)).toBe(false);
    expect(needsDetail("x".repeat(DETAIL_TEXT_LIMIT))).toBe(false);
    expect(needsDetail("x".repeat(DETAIL_TEXT_LIMIT + 1))).toBe(true);
    expect(needsDetail("line 1\nline 2")).toBe(true);
  });
});
