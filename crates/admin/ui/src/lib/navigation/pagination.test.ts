import { describe, expect, it } from "vitest";

import { pageAfterEmpty, parsePage } from "./pagination";

describe("URL pagination", () => {
  it.each([
    null,
    "",
    "NaN",
    "Infinity",
    "-Infinity",
    "-1",
    "1.5",
    "1abc",
    "1e3",
    "0x10",
    "9".repeat(400),
    "9007199254740992",
  ])("rejects invalid page %s", (value) => {
    expect(parsePage(value)).toBe(0);
  });

  it.each([
    ["0", 0],
    ["25", 25],
    ["0002", 2],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ])("reads complete page %s", (value, expected) => {
    expect(parsePage(value)).toBe(expected);
  });
});

describe("pageAfterEmpty", () => {
  it("keeps the first page: an empty first page is an empty table", () => {
    expect(pageAfterEmpty({ page: 0, size: 50, total: 0, exact: true })).toBeNull();
  });

  it("jumps to the last page when the total is exact", () => {
    expect(pageAfterEmpty({ page: 2, size: 50, total: 100, exact: true })).toBe(1);
    // A stale link far past the end goes straight to the last page.
    expect(pageAfterEmpty({ page: 99, size: 50, total: 120, exact: true })).toBe(2);
    expect(pageAfterEmpty({ page: 3, size: 50, total: 0, exact: true })).toBe(0);
  });

  it("steps back one page when the total is estimated or unknown", () => {
    expect(pageAfterEmpty({ page: 3, size: 50, total: 1000, exact: false })).toBe(2);
    expect(pageAfterEmpty({ page: 1, size: 50, total: null, exact: false })).toBe(0);
  });
});
