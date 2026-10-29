import { translate } from "$lib/i18n/index.svelte";
import { describe as group, expect, it } from "vitest";

import { requiredValue } from "../../contracts/required-value.js";
import {
  describe,
  filtersParam,
  filtersToSearch,
  fromUi,
  parseFilters,
  toUi,
  type TableFilter,
} from "./filters";

group("filters in the URL", () => {
  it("reads the REST API format, including negation and values with dots", () => {
    const query = new URLSearchParams("price=gte.10&name=ilike.*a.b*&stock=not.eq.0");
    expect(parseFilters(query)).toEqual([
      { column: "price", op: "gte", value: "10" },
      { column: "name", op: "ilike", value: "*a.b*" },
      { column: "stock", op: "eq", value: "0", not: true },
    ]);
  });

  it("ignores pairs that are not filters", () => {
    expect(parseFilters(new URLSearchParams("x=nodot&y=in.(1,2)&z=drop.table"))).toEqual([]);
  });

  it("a round trip keeps the filters, including accents and &", () => {
    const filters: TableFilter[] = [
      { column: "café", op: "eq", value: "a&b=c" },
      { column: "id", op: "is", value: "null", not: true },
    ];
    expect(parseFilters(new URLSearchParams(filtersToSearch(filters)))).toEqual(filters);
  });

  it("accepts more than one filter on the same column", () => {
    const query = new URLSearchParams("price=gt.1&price=lt.10");
    expect(parseFilters(query).map((f) => f.op)).toEqual(["gt", "lt"]);
  });
});

it('form operators > "contains" becomes ilike with wildcards and back', () => {
  const wire = fromUi({ column: "name", op: "contains", value: "can" });
  expect(wire).toEqual({ column: "name", op: "ilike", value: "*can*" });
  expect(toUi(wire)).toEqual({ op: "contains", value: "can" });
});

it("form operators > NULL and not NULL use is (with and without not)", () => {
  expect(fromUi({ column: "x", op: "null", value: "" })).toEqual({
    column: "x",
    op: "is",
    value: "null",
  });
  // A negated filter opened in the form and applied again stays negated.
  expect(fromUi({ column: "status", op: "eq", value: "cancelled", not: true })).toEqual({
    column: "status",
    op: "eq",
    value: "cancelled",
    not: true,
  });
  expect(fromUi({ column: "name", op: "contains", value: "a", not: true })).toEqual({
    column: "name",
    op: "ilike",
    value: "*a*",
    not: true,
  });
  expect(fromUi({ column: "x", op: "null", value: "", not: true })).toEqual({
    column: "x",
    op: "is",
    value: "null",
  });
  expect(toUi(fromUi({ column: "x", op: "notnull", value: "" }))).toEqual({
    op: "notnull",
    value: "",
  });
});

it("form operators > describes the filter in the chosen language", () => {
  const pt = (key: string) => translate("pt-BR", key);
  expect(describe(fromUi({ column: "price", op: "gte", value: "10" }), pt)).toBe(
    "price maior ou igual a 10",
  );
  expect(describe(fromUi({ column: "email", op: "notnull", value: "" }), pt)).toBe(
    "email não está vazio",
  );
  expect(describe({ column: "n", op: "eq", value: "0", not: true }, pt)).toBe("n não igual a 0");
  const en = (key: string) => translate("en", key);
  expect(describe(fromUi({ column: "price", op: "gte", value: "10" }), en)).toBe(
    "price greater than or equal to 10",
  );
  expect(describe(fromUi({ column: "email", op: "notnull", value: "" }), en)).toBe(
    "email is not empty",
  );
  expect(describe({ column: "n", op: "eq", value: "0", not: true }, en)).toBe("n not equal to 0");
});

group("API parameter", () => {
  it("omits the parameter without filters and serializes them as JSON", () => {
    expect(filtersParam([])).toBeUndefined();
    expect(
      JSON.parse(
        requiredValue(
          filtersParam([{ column: "a", op: "eq", value: "1" }]),
          "required operation value",
        ),
      ),
    ).toEqual([{ column: "a", op: "eq", value: "1" }]);
  });
});
