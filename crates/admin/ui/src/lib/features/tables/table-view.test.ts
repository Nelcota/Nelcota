import { describe, expect, it } from "vitest";

import { requiredValue } from "../../contracts/required-value.js";
import { parseFilters } from "./filters";
import { rowKey, rowPk } from "./rows/grid";
import { parseTableView, tableViewSearch } from "./table-view";

describe("table context", () => {
  it("preserves filters while changing page, size and sorting", () => {
    const search = tableViewSearch(new URLSearchParams("status=eq.paid"), {
      page: 2,
      size: "100",
      sort: { column: "created_at", desc: true },
    });
    const params = new URLSearchParams(search);
    expect(parseFilters(params)).toEqual([{ column: "status", op: "eq", value: "paid" }]);
    expect(parseTableView(params)).toEqual({
      page: 2,
      size: "100",
      sort: { column: "created_at", desc: true },
    });
    expect(
      parseTableView(new URLSearchParams(tableViewSearch(params, { page: 0, sort: null }))),
    ).toEqual({ page: 0, size: "100", sort: null });
  });

  it("rejects malformed paging parameters without affecting valid filters", () => {
    const query = new URLSearchParams("_page=-1&_size=999999&title=ilike.*test*");
    expect(parseTableView(query)).toEqual({ page: 0, size: "50", sort: null });
    expect(parseFilters(query)).toHaveLength(1);
  });

  it.each([NaN, Infinity, -1, 0.5])(
    "keeps invalid page %s out of the URL while preserving filters",
    (page) => {
      const params = new URLSearchParams(
        tableViewSearch(new URLSearchParams("title=eq.test&_page=2"), { page, size: "100" }),
      );
      expect(params.has("_page")).toBe(false);
      expect(parseTableView(params).size).toBe("100");
      expect(params.get("title")).toBe("eq.test");
    },
  );
});

describe("row identity", () => {
  it("keeps the original composite primary key after reordering or editing", () => {
    let rows = [
      { tenant: "a", id: "1", title: "first" },
      { tenant: "b", id: "1", title: "second" },
    ];
    const pk = rowPk(requiredValue(rows[0], "test fixture item"), ["tenant", "id"]);
    const key = rowKey(pk, ["tenant", "id"]);
    rows = rows.toReversed();
    requiredValue(rows[1], "test fixture item").id = "2";
    expect(pk).toEqual({ tenant: "a", id: "1" });
    expect(key).not.toBe(rowKey(requiredValue(rows[0], "test fixture item"), ["tenant", "id"]));
    expect(key).not.toBe(rowKey(requiredValue(rows[1], "test fixture item"), ["tenant", "id"]));
  });
});
