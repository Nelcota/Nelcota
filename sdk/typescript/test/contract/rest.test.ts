import fc from "fast-check";
import { expect, it } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { escapeLike } from "../../src/index.js";
import { signedIn, visitor } from "./setup.js";

it("REST against the server: returns precise and nullable scalar sets and rows from views", async () => {
  const nelcota = visitor();
  expect(await nelcota.rpc("precision_samples")).toMatchObject({
    error: null,
    data: [1.25, "12345678901234567890.123456789", null],
  });
  expect(await nelcota.rpc("measurement_rows")).toMatchObject({
    error: null,
    data: [
      {
        id: "9007199254740993",
        amount: "12345678901234567890.123456789",
        tags: ["valid", null],
        states: ["open", null],
      },
    ],
  });
});

it("REST against the server: round-trips exact bigint and numeric values through reads, filters, writes and RPC", async () => {
  const nelcota = visitor();
  const row = {
    id: "9007199254740993",
    amount: "12345678901234567890.123456789",
    tags: ["valid", null],
    states: ["open" as const, null],
  };
  const first = await nelcota.from("measurements").select().eq("id", row.id).single().execute();
  expect(first).toMatchObject({ error: null, data: row });
  expect(
    (
      await nelcota
        .from("measurements")
        .select()
        .eq("id", requiredValue(first.data, "response data").id)
        .single()
        .execute()
    ).data,
  ).toEqual(row);
  expect((await nelcota.rpc("echo_numeric", { value: row.amount })).data).toBe(row.amount);
  const { client } = await signedIn();
  const inserted = { ...row, id: "9007199254740995" };
  expect(
    await client.from("measurements").insert(inserted).select().single().execute(),
  ).toMatchObject({
    error: null,
    data: inserted,
  });
  expect(
    await client
      .from("measurements")
      .update({ amount: row.amount })
      .eq("id", inserted.id)
      .select()
      .single()
      .execute(),
  ).toMatchObject({ error: null, data: inserted });
  expect(
    (await client.from("measurements").delete().eq("id", inserted.id).execute()).error,
  ).toBeNull();
});

it("REST against the server: reads as a visitor with order, paging and an exact count", async () => {
  const nelcota = visitor();
  const { data, error, count } = await nelcota
    .from("customers")
    .select("id,name", { count: "exact" })
    .order("id", { ascending: false })
    .range(0, 1)
    .execute();
  expect(error).toBeNull();
  expect(count).toBe(3);
  expect(data?.map((c) => c.name)).toEqual(['Ruler, "30cm" (wood)', "Bruno"]);

  const head = await nelcota
    .from("customers")
    .select("*", { count: "exact", head: true })
    .execute();
  expect(head).toMatchObject({ data: null, error: null, count: 3 });
});

it("REST against the server: reports the returned range, offsets and walks every page", async () => {
  const nelcota = visitor();
  const second = await nelcota
    .from("customers")
    .select("id")
    .order("id")
    .limit(1)
    .offset(1)
    .execute();
  expect(second).toMatchObject({ error: null, range: { from: 1, to: 1 }, count: null });
  const empty = await nelcota.from("customers").select("id").order("id").offset(100).execute();
  expect(empty).toMatchObject({ data: [], error: null, range: null });

  const all = (await nelcota.from("customers").select("id").order("id").throwOnError().execute())
    .data;
  const paged: unknown[] = [];
  for await (const page of nelcota.from("customers").select("id").order("id").pages(2))
    paged.push(...page);
  expect(paged).toEqual(all);
});

it("REST against the server: finds values with delimiters through every operator form", async () => {
  const nelcota = visitor();
  const name = 'Ruler, "30cm" (wood)';
  for (const query of [
    nelcota.from("customers").select("name").eq("name", name),
    nelcota.from("customers").select("name").in("name", [name, "nobody"]),
    nelcota
      .from("customers")
      .select("name")
      .or((c) => [c.eq("name", name), c.eq("name", "x,y)")]),
    nelcota
      .from("customers")
      .select("name")
      .ilike("name", `*${escapeLike('"30cm" (')}*`),
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- Keep authenticated server cases within the fixture worker in their declared order.
    const { data, error } = await query.execute();
    expect(error).toBeNull();
    expect(data).toEqual([{ name }]);
  }
  const single = await nelcota
    .from("customers")
    .select("name")
    .eq("name", "Ana")
    .single()
    .execute();
  expect(single.data).toEqual({ name: "Ana" });
  const many = await nelcota.from("customers").select("name").single().execute();
  expect(many.error?.code).toBe("not_single");
});

it("REST against the server: round-trips arbitrary text through eq, in and or groups", async () => {
  const { client } = await signedIn();
  const text = arbitraryFilterText();
  await fc.assert(
    fc.asyncProperty(text, async (value) => {
      const inserted = await client
        .from("echo")
        .insert({ value })
        .select("id,value")
        .single()
        .execute();
      expect(inserted.error).toBeNull();
      expect(inserted.data?.value).toBe(value);
      const id = requiredValue(
        inserted.data,
        "sdk/typescript/test/contract/rest.test.ts: inserted.data",
      ).id;
      const queries = [
        client.from("echo").select("id").eq("value", value),
        client.from("echo").select("id").in("value", [value]),
        client
          .from("echo")
          .select("id")
          .or((c) => [c.eq("value", value), c.and([c.eq("value", value), c.is("slug", null)])]),
      ];
      for (const query of queries) {
        // oxlint-disable-next-line no-await-in-loop -- Keep authenticated server cases within the fixture worker in their declared order.
        const { data, error } = await query.execute();
        expect(error).toBeNull();
        expect(data).toEqual([{ id }]);
      }
      await client.from("echo").delete().eq("id", id).execute();
    }),
    { numRuns: 40 },
  );
});

it("REST against the server: writes under RLS: each user sees only their own rows", async () => {
  const ana = await signedIn();
  const bruno = await signedIn();
  const created = await ana.client
    .from("orders")
    .insert({ total: 30, customer_id: 1 })
    .select("id,owner,total,status")
    .single()
    .execute();
  expect(created.error).toBeNull();
  expect(created.data).toMatchObject({ owner: ana.id, total: 30, status: "open" });
  const id = requiredValue(
    created.data,
    "sdk/typescript/test/contract/rest.test.ts: created.data",
  ).id;

  expect((await bruno.client.from("orders").select("id").eq("id", id).execute()).data).toEqual([]);
  const theft = await bruno.client
    .from("orders")
    .update({ status: "paid" })
    .eq("id", id)
    .select("id")
    .execute();
  expect(theft.data).toEqual([]);

  const updated = await ana.client
    .from("orders")
    .update({ status: "paid" })
    .eq("id", id)
    .select("status")
    .single()
    .execute();
  expect(updated.data).toEqual({ status: "paid" });
  const removed = await ana.client.from("orders").delete().eq("id", id).select("id").execute();
  expect(removed.data).toEqual([{ id }]);
});

it("REST against the server: embeds related rows with their own filters, order and limit", async () => {
  const { client } = await signedIn();
  const order = await client
    .from("orders")
    .insert({ customer_id: 2, total: 9 })
    .select("id")
    .single()
    .execute();
  const orderId = requiredValue(
    order.data,
    "sdk/typescript/test/contract/rest.test.ts: order.data",
  ).id;
  await client
    .from("items")
    .insert([
      { order_id: orderId, product: "Pen", qty: 2 },
      { order_id: orderId, product: "Ruler", qty: 1 },
      { order_id: orderId, product: "Ink", qty: 5 },
    ])
    .execute();
  const { data, error } = await client
    .from("orders")
    .select("id,customer:customers(name),items(product,qty)")
    .eq("id", orderId)
    .gte("items.qty", 2)
    .order("qty", { referencedTable: "items", ascending: false })
    .limit(1, { referencedTable: "items" })
    .single()
    .execute();
  expect(error).toBeNull();
  expect(data).toEqual({
    id: orderId,
    customer: { name: "Bruno" },
    items: [{ product: "Ink", qty: 5 }],
  });
});

it("REST against the server: upserts by a unique column", async () => {
  const { client } = await signedIn();
  const slug = `slug-${Date.now()}`;
  await client.from("echo").upsert({ value: "first", slug }, { onConflict: "slug" }).execute();
  await client.from("echo").upsert({ value: "second", slug }, { onConflict: "slug" }).execute();
  await client
    .from("echo")
    .upsert({ value: "ignored", slug }, { onConflict: "slug", ignoreDuplicates: true })
    .execute();
  expect((await client.from("echo").select("value").eq("slug", slug).execute()).data).toEqual([
    { value: "second" },
  ]);
});

it("REST against the server: calls functions with the caller role", async () => {
  const anon = visitor();
  expect((await anon.rpc("add", { a: 2 })).data).toBe(12);
  expect((await anon.rpc("whoami")).data).toBe("anon");
  expect(await anon.rpc("nothing")).toEqual({ data: null, error: null, status: 204 });
  const ana = await signedIn();
  expect((await ana.client.rpc("whoami")).data).toBe(ana.id);
});

it("REST against the server: passes server errors through untouched", async () => {
  const anon = visitor();
  const denied = await anon.from("orders").select().execute();
  expect(denied.error).toMatchObject({ status: 401, code: "db_error" });
  const { client } = await signedIn();
  const noFilter = await client.from("orders").delete().execute();
  expect(noFilter.error).toMatchObject({ status: 400, code: "invalid_query" });
  const badValue = await client.from("orders").select().eq("total", "abc").execute();
  expect(badValue.error?.status).toBe(400);
});

function arbitraryFilterText() {
  const specials = fc.constantFrom(
    ",",
    "(",
    ")",
    '"',
    "\\",
    ".",
    "*",
    "%",
    "_",
    " ",
    "&",
    "=",
    "#",
    "?",
    "+",
    ":",
    "!",
    "'",
    ";",
    "\n",
    "\t",
  );
  const text = fc
    .array(fc.oneof(specials, fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 })), {
      minLength: 1,
      maxLength: 12,
    })
    .map((parts) => parts.join(""))
    .filter((s) => s.includes("\u0000") === false);

  return text;
}
