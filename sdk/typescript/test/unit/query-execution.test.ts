import { expect, it } from "vitest";

import { createClient, NelcotaUsageError } from "../../src/index.js";
import { json, mockFetch } from "./http-fixtures.js";

function client(...replies: Parameters<typeof mockFetch>) {
  const mock = mockFetch(...replies);
  const nelcota = createClient("https://api.example.test", {
    fetch: mock.fetch,
    auth: { autoRefresh: false },
  });
  return { nelcota, calls: mock.calls };
}

it("keeps query construction inert until execute is called", async () => {
  const { nelcota, calls } = client(json([{ id: 1 }]));
  const query = nelcota.from("notes").select("id");

  expect(calls).toHaveLength(0);

  const result = await query.execute();

  expect(result.error).toBeNull();
  expect(result.data).toEqual([{ id: 1 }]);
  expect(calls).toHaveLength(1);
});

it("rejects an accidental await of a builder instead of resolving to it", async () => {
  const { nelcota, calls } = client(json([]));
  const query = nelcota.from("notes").select("id");

  await expect(Promise.resolve(query)).rejects.toThrow(NelcotaUsageError);
  await expect(Promise.resolve(query)).rejects.toThrow("call .execute()");
  // Returning a builder from a promise callback adopts it, like an async return.
  const returned = Promise.resolve().then(() => nelcota.from("notes").select().eq("id", 1));
  await expect(returned).rejects.toBeInstanceOf(NelcotaUsageError);
  expect(() => {
    query.then();
  }).toThrow(NelcotaUsageError);
  expect(calls).toHaveLength(0);
  // The builder itself still works.
  expect((await query.execute()).error).toBeNull();
});

it.each([
  ["update", "limit"],
  ["update", "offset"],
  ["update", "order"],
  ["update", "range"],
  ["delete", "limit"],
  ["delete", "order"],
  ["insert", "limit"],
  ["insert", "order"],
  ["insert", "eq"],
  ["insert", "or"],
  ["insert", "match"],
] as const)("refuses %s().%s() before sending: the server rejects it", (write, modifier) => {
  const { nelcota } = client();
  const table = nelcota.from("notes");
  const query = {
    update: () => table.update({ body: "x" }).eq("id", 1).select(),
    delete: () => table.delete().eq("id", 1).select(),
    insert: () => table.insert({ body: "x" }).select(),
  }[write]();
  const apply = {
    limit: () => query.limit(1),
    offset: () => query.offset(1),
    order: () => query.order("id"),
    range: () => query.range(0, 1),
    eq: () => query.eq("id", 1),
    or: () => query.or((c) => [c.eq("id", 1)]),
    match: () => query.match({ id: 1 }),
  }[modifier];
  expect(apply).toThrow(NelcotaUsageError);
});

it("keeps embedded modifiers on a write's returned representation", () => {
  const { nelcota } = client();
  const query = nelcota
    .from("notes")
    .update({ body: "x" })
    .eq("id", 1)
    .select("id, comments(id)")
    .order("id", { referencedTable: "comments" })
    .limit(5, { referencedTable: "comments" })
    .eq("comments.id", 2);
  expect(query.toString()).toContain("comments.limit=5");
  const insert = nelcota
    .from("notes")
    .insert({ body: "x" })
    .select("id, comments(id)")
    .limit(1, { referencedTable: "comments" });
  expect(insert.toString()).toContain("comments.limit=1");
});

it.each(["single", "maybeSingle"] as const)(
  "refuses %s on update/delete before any row changes",
  (mode) => {
    const { nelcota } = client();
    const update = nelcota.from("notes").update({ body: "x" }).eq("id", 1).select();
    const remove = nelcota.from("notes").delete().eq("id", 1).select();
    expect(() => update[mode]()).toThrow(NelcotaUsageError);
    expect(() => remove[mode]()).toThrow(NelcotaUsageError);
    // Inserts know their row count from the body and stay allowed.
    expect(() => nelcota.from("notes").insert({ body: "x" }).select()[mode]()).not.toThrow();
  },
);

it("pages() respects an existing limit as the total number of rows", async () => {
  const { nelcota, calls } = client(
    json([{ id: 1 }, { id: 2 }]),
    json([{ id: 3 }, { id: 4 }]),
    json([{ id: 5 }]),
  );
  const pages: unknown[][] = [];
  for await (const page of nelcota.from("notes").select().order("id").limit(5).pages(2))
    pages.push(page);
  expect(pages.flat()).toHaveLength(5);
  expect(
    calls.map((call) => [call.url.searchParams.get("offset"), call.url.searchParams.get("limit")]),
  ).toEqual([
    ["0", "2"],
    ["2", "2"],
    ["4", "1"],
  ]);
});
