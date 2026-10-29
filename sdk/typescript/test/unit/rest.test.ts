import { expect, it } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { escapeLike, NelcotaUsageError } from "../../src/index.js";
import { countFromRange, rangeFromHeader } from "../../src/rest/query.js";
import { empty, json } from "./http-fixtures.js";
import { client, query } from "./rest-fixtures.js";

it("reads: sends one GET with the filters, order and paging", async () => {
  const { nelcota, calls } = client(json([{ id: 1 }], 200, { "content-range": "0-0/1" }));
  const { data, error, count, status } = await nelcota
    .from("todos")
    .select("id, title, owner:users(email)", { count: "exact" })
    .eq("done", false)
    .in("priority", ["high", 'a,"b"'])
    .ilike("title", `*${escapeLike("50%")}*`)
    .is("deleted_at", null)
    .not("status", "eq", "cancelled")
    .gte("orders.total", 5)
    .order("id", { ascending: false, nullsFirst: false })
    .order("title")
    .order("qty", { referencedTable: "orders" })
    .range(20, 39)
    .limit(2, { referencedTable: "orders" })
    .execute();
  expect(error).toBeNull();
  expect(data).toEqual([{ id: 1 }]);
  expect(count).toBe(1);
  expect(status).toBe(200);
  expect(calls).toHaveLength(1);
  const call = requiredValue(calls[0], "recorded request");
  expect(call.method).toBe("GET");
  expect(call.url.pathname).toBe("/rest/v1/todos");
  expect(call.headers.get("prefer")).toBe("count=exact");
  expect(query(call.url)).toEqual([
    ["select", "id,title,owner:users(email)"],
    ["done", "eq.false"],
    ["priority", 'in.("high","a,\\"b\\"")'],
    ["title", "ilike.*50\\%*"],
    ["deleted_at", "is.null"],
    ["status", "not.eq.cancelled"],
    ["orders.total", "gte.5"],
    ["order", "id.desc.nullslast,title.asc"],
    ["orders.order", "qty.asc"],
    ["offset", "20"],
    ["limit", "20"],
    ["orders.limit", "2"],
  ]);
});

it("reads: builds or/and groups from typed conditions", async () => {
  const { nelcota, calls } = client(json([]));
  await nelcota
    .from("products")
    .select()
    .or((c) => [
      c.eq("name", "Ruler, 30cm"),
      c.and([c.gt("price", 100), c.not(c.is("featured", true))]),
    ])
    .or((c) => [c.eq("qty", 1)], { referencedTable: "items" })
    .execute();
  expect(query(requiredValue(calls[0], "recorded test item").url)).toEqual([
    ["select", "*"],
    ["or", '(name.eq."Ruler, 30cm",and(price.gt."100",featured.not.is.true))'],
    ["items.or", '(qty.eq."1")'],
  ]);
});

it("reads: keeps builders immutable, so a base query can be reused", async () => {
  const { nelcota, calls } = client(json([]));
  const base = nelcota.from("todos").select("id").eq("done", false);
  await base.eq("id", 1).execute();
  await base.eq("id", 2).execute();
  expect(query(requiredValue(calls[0], "recorded test item").url)).toEqual([
    ["select", "id"],
    ["done", "eq.false"],
    ["id", "eq.1"],
  ]);
  expect(query(requiredValue(calls[1], "recorded test item").url)).toEqual([
    ["select", "id"],
    ["done", "eq.false"],
    ["id", "eq.2"],
  ]);
});

it("reads: single asks for two rows at most and checks there is exactly one", async () => {
  const one = client(json([{ id: 1 }]));
  expect((await one.nelcota.from("todos").select().eq("id", 1).single().execute()).data).toEqual({
    id: 1,
  });
  expect(requiredValue(one.calls[0], "recorded test item").url.searchParams.get("limit")).toBe("2");

  const many = client(json([{ id: 1 }, { id: 2 }]));
  const result = await many.nelcota.from("todos").select().single().execute();
  expect(result.error?.code).toBe("not_single");
  expect(result.error?.message).toContain("more than one");

  const none = client(json([]));
  expect((await none.nelcota.from("todos").select().maybeSingle().execute()).data).toBeNull();
  expect((await none.nelcota.from("todos").select().single().execute()).error?.code).toBe(
    "not_single",
  );
});

it("reads: head counts without rows", async () => {
  const { nelcota, calls } = client(empty(200, { "content-range": "*/137" }));
  const { data, count } = await nelcota
    .from("todos")
    .select("*", { count: "exact", head: true })
    .execute();
  expect(requiredValue(calls[0], "recorded test item").method).toBe("HEAD");
  expect(data).toBeNull();
  expect(count).toBe(137);
});

it("reads: refuses cardinality on minimal writes and HEAD before sending", () => {
  const { nelcota, calls } = client(empty());
  const minimal = nelcota.from("todos").insert({ title: "a" });
  // @ts-expect-error minimal writes do not have a row representation
  expect(() => minimal.single()).toThrow(NelcotaUsageError);
  // @ts-expect-error minimal writes do not have a row representation
  expect(() => minimal.maybeSingle()).toThrow(NelcotaUsageError);
  const head = nelcota.from("todos").select("*", { head: true }).select("id");
  // @ts-expect-error HEAD never returns rows, even after another select
  expect(() => head.single()).toThrow(NelcotaUsageError);
  // @ts-expect-error HEAD never returns rows
  expect(() => head.maybeSingle()).toThrow(NelcotaUsageError);
  expect(calls).toHaveLength(0);
});

it.each([empty(200), json({ id: 1 }), json(null)].map((value) => [value] as const))(
  "reads: rejects empty or non-array representations instead of returning typed rows [%#]",
  async (response) => {
    const { nelcota } = client(response);
    expect((await nelcota.from("todos").select().execute()).error?.code).toBe("invalid_response");
    expect((await nelcota.from("todos").select().single().execute()).error?.code).toBe(
      "invalid_response",
    );
  },
);

it("reads: reads totals from Content-Range", () => {
  expect(countFromRange("0-19/137")).toBe(137);
  expect(countFromRange("0-19/*")).toBeNull();
  expect(countFromRange("*/0")).toBe(0);
  expect(countFromRange(null)).toBeNull();
  expect(rangeFromHeader("20-39/137")).toEqual({ from: 20, to: 39 });
  expect(rangeFromHeader("0-0/*")).toEqual({ from: 0, to: 0 });
  expect(rangeFromHeader("*/0")).toBeNull();
  expect(rangeFromHeader(null)).toBeNull();
});

it.each([
  "0-0/-1",
  "0-0/+1",
  "0-0/0x10",
  "0-0/1e2",
  "0-0/1.5",
  "0-0/1/2",
  "0-0/9007199254740992",
  "garbage/12",
  "0-0/ 12",
])("reads: ignores invalid totals in %s", (header) => {
  expect(countFromRange(header)).toBeNull();
});

it("reads: keeps runtime cardinality when reselecting singular queries", async () => {
  const { nelcota } = client(json([{ id: 1 }]));
  try {
    expect((await nelcota.from("todos").select().single().select("id").execute()).data).toEqual({
      id: 1,
    });
    const empty = client(json([]));
    try {
      expect(
        (await empty.nelcota.from("todos").select().maybeSingle().select("id").execute()).data,
      ).toBeNull();
    } finally {
      empty.nelcota.dispose();
    }
  } finally {
    nelcota.dispose();
  }
});

it("reads: exposes the returned range so truncation is visible", async () => {
  const { nelcota, calls } = client(
    json([{ id: 1 }, { id: 2 }], 200, { "content-range": "10-11/40" }),
  );
  const result = await nelcota
    .from("todos")
    .select("id", { count: "exact" })
    .limit(2)
    .offset(10)
    .execute();
  expect(result).toMatchObject({ count: 40, range: { from: 10, to: 11 } });
  expect(query(requiredValue(calls[0], "recorded test item").url)).toEqual([
    ["select", "id"],
    ["limit", "2"],
    ["offset", "10"],
  ]);
  expect(nelcota.from("todos").select().offset(3).offset(5).toString()).toBe("select=*&offset=5");
  expect(nelcota.from("todos").select().offset(2, { referencedTable: "items" }).toString()).toBe(
    "select=*&items.offset=2",
  );
  expect(() => nelcota.from("todos").select().offset(-1)).toThrow(NelcotaUsageError);
  expect(
    (await client(empty(201)).nelcota.from("todos").insert({ id: 1 }).execute()).range,
  ).toBeNull();
});

it("reads: pages through every row until an empty page", async () => {
  const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }], []];
  const { nelcota, calls } = client(() => json(pages.shift()));
  const seen: unknown[] = [];
  for await (const page of nelcota.from("todos").select("id").order("id").offset(4).pages(2))
    seen.push(page);
  expect(seen).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]);
  // A short page does not end the walk: the server may cap pages below `size`.
  expect(
    calls.map((c) => [c.url.searchParams.get("offset"), c.url.searchParams.get("limit")]),
  ).toEqual([
    ["4", "2"],
    ["6", "2"],
    ["7", "2"],
  ]);
});
