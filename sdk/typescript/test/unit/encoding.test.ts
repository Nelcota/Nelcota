import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { NelcotaUsageError } from "../../src/core/client.errors.js";
import {
  bucketId,
  columnPath,
  escapeLike,
  folderPrefix,
  identifier,
  inList,
  objectPath,
  quote,
  scalar,
} from "../../src/core/encoding.js";
import { requiredValue } from "../../src/core/required-value.js";
import { Conditions } from "../../src/rest/conditions.js";
import { encodeGroup } from "../../src/rest/conditions.js";
import { parseInList, readFilter, splitTopLevel } from "./server-grammar.js";

describe("identifiers", () => {
  it("accepts names the grammar can carry", () => {
    for (const name of ["id", "created_at", "Preço", "a-b", "x1", "é".repeat(31)]) {
      expect(identifier(name)).toBe(name);
    }
  });

  it("refuses delimiters, whitespace, control characters and long names", () => {
    for (const name of [
      "",
      "a.b",
      "a,b",
      "a(b",
      "a)",
      'a"b',
      "a:b",
      "a!b",
      "*",
      "a b",
      "a\nb",
      "a\\b",
      "x".repeat(64),
      "é".repeat(32),
    ]) {
      expect(() => identifier(name), name).toThrow(NelcotaUsageError);
    }
  });

  it("validates each segment of an embed path", () => {
    expect(columnPath("orders.items.qty")).toBe("orders.items.qty");
    expect(() => columnPath("orders..qty")).toThrow(NelcotaUsageError);
    expect(() => columnPath("orders.qty,id")).toThrow(NelcotaUsageError);
  });
});

it("values > renders scalars as Postgres text", () => {
  expect(scalar("a,b")).toBe("a,b");
  expect(scalar(42)).toBe("42");
  expect(scalar(10n ** 20n)).toBe("100000000000000000000");
  expect(scalar(false)).toBe("false");
  expect(scalar(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
});

it("values > refuses values without a faithful text form", () => {
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
    {},
    [],
    Symbol("x"),
    new Date(Number.NaN),
  ]) {
    expect(() => scalar(value)).toThrow(NelcotaUsageError);
  }
});

it("values > quotes with the grammar escapes", () => {
  expect(quote('say "hi" \\ there')).toBe('"say \\"hi\\" \\\\ there"');
});

it("values > in lists read back exactly as given (server grammar)", () => {
  fc.assert(
    fc.property(
      fc.array(fc.string({ unit: "binary" }), { minLength: 1, maxLength: 8 }),
      (values) => {
        expect(parseInList(inList(values))).toEqual(values);
      },
    ),
    { numRuns: 500 },
  );
});

it("values > group values read back exactly and never add conditions (server grammar)", () => {
  const c = new Conditions<{ name: string; n: number }>();
  fc.assert(
    fc.property(fc.string({ unit: "binary" }), fc.string({ unit: "binary" }), (a, b) => {
      const group = encodeGroup([c.eq("name", a), c.or([c.eq("name", b), c.is("name", null)])]);
      const items = splitTopLevel(group.slice(1, -1));
      expect(items).toHaveLength(2);
      expect(readFilter(requiredValue(items[0], "first filter"))).toEqual(["name", "eq", a]);
      const nested = splitTopLevel(requiredValue(items[1], "recorded test item").slice(3, -1));
      expect(nested).toHaveLength(2);
      expect(readFilter(requiredValue(nested[0], "first nested filter"))).toEqual([
        "name",
        "eq",
        b,
      ]);
    }),
    { numRuns: 500 },
  );
});

it("values > escapes LIKE wildcards in typed text", () => {
  expect(escapeLike("50%_off\\*")).toBe("50\\%\\_off\\\\_");
});

describe("conditions", () => {
  const c = new Conditions<{ status: string; qty: number }>();
  const text = (items: Parameters<typeof encodeGroup>[0]) => encodeGroup(items);

  it("negates filters and groups, and double negation cancels", () => {
    expect(text([c.not(c.eq("status", "x"))])).toBe('(status.not.eq."x")');
    expect(text([c.not(c.not(c.eq("status", "x")))])).toBe('(status.eq."x")');
    expect(text([c.not(c.or([c.gt("qty", 1)]))])).toBe('(not.or(qty.gt."1"))');
    expect(text([c.not(c.not(c.and([c.gt("qty", 1)])))])).toBe('(and(qty.gt."1"))');
    expect(text([c.in("qty", [1, 2]), c.is("status", null)])).toBe(
      '(qty.in.("1","2"),status.is.null)',
    );
  });

  it("refuses empty groups and foreign objects", () => {
    expect(() => encodeGroup([])).toThrow(NelcotaUsageError);
    expect(() => encodeGroup([{} as never])).toThrow(NelcotaUsageError);
  });
});

it("storage names > encodes each segment and keeps the folders", () => {
  expect(objectPath("a b/c#d?.png")).toBe("a%20b/c%23d%3F.png");
  expect(objectPath("100%/x")).toBe("100%25/x");
});

it("storage names > normalizes to NFC like the server", () => {
  expect(objectPath("café.txt")).toBe(encodeURIComponent("café.txt"));
});

it("storage names > refuses names that could climb out of the bucket or be ambiguous", () => {
  for (const name of [
    "",
    "..",
    "../x",
    "a/../b",
    "a/./b",
    "/a",
    "a/",
    "a//b",
    "a\\b",
    "a\u0000b",
    "x".repeat(256),
    `${"a/".repeat(600)}a`,
  ]) {
    expect(() => objectPath(name), JSON.stringify(name)).toThrow(NelcotaUsageError);
  }
});

it("storage names > never yields a path that escapes, whatever the input", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 64 }), (name) => {
      let path: string;
      try {
        path = objectPath(name);
      } catch (error) {
        expect(error).toBeInstanceOf(NelcotaUsageError);
        return;
      }
      for (const segment of path.split("/")) {
        expect(["", ".", ".."]).not.toContain(decodeURIComponent(segment));
        expect(segment).not.toMatch(/[?#\\]/);
      }
    }),
    { numRuns: 1000 },
  );
});

it("storage names > checks bucket ids and prefixes", () => {
  expect(bucketId("user-files_2")).toBe("user-files_2");
  for (const id of ["", "Avatars", "-a", "a/b", "public", "sign", "list", "x".repeat(64)]) {
    expect(() => bucketId(id), id).toThrow(NelcotaUsageError);
  }
  expect(folderPrefix("")).toBe("");
  expect(folderPrefix("a/b/")).toBe("a/b/");
  expect(() => folderPrefix("a")).toThrow(NelcotaUsageError);
  expect(() => folderPrefix("../")).toThrow(NelcotaUsageError);
});
