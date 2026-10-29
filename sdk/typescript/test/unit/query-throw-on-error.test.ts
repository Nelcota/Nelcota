import { expect, it } from "vitest";

import { requiredValue } from "../../src/core/required-value.js";
import { NelcotaUsageError, unwrap } from "../../src/index.js";
import { empty, json } from "./http-fixtures.js";
import { client, query } from "./rest-fixtures.js";

it("reads: throwOnError() throws the error and keeps successes as results", async () => {
  const failing = client(json({ code: "db_error", message: "nope", sqlstate: "42501" }, 403));
  await expect(
    failing.nelcota.from("todos").select().throwOnError().execute(),
  ).rejects.toMatchObject({
    name: "NelcotaError",
    code: "db_error",
    sqlstate: "42501",
  });
  await expect(
    failing.nelcota.from("todos").select().throwOnError().execute(),
  ).rejects.toMatchObject({ status: 403 });

  const { nelcota } = client(json([{ id: 1 }], 200, { "content-range": "0-0/*" }));
  const { data, error } = await nelcota
    .from("todos")
    .select("id")
    .throwOnError()
    .eq("id", 1)
    .execute();
  expect(error).toBeNull();
  expect(data).toEqual([{ id: 1 }]);
  await expect(
    nelcota.from("todos").select("id").throwOnError().single().execute(),
  ).resolves.toMatchObject({ data: { id: 1 } });

  const many = client(json([{ id: 1 }, { id: 2 }]));
  await expect(
    many.nelcota.from("todos").select().single().throwOnError().execute(),
  ).rejects.toMatchObject({ code: "not_single" });
});

it("reads: unwrap() returns the data or throws the error", async () => {
  const { nelcota } = client(json([{ id: 1 }]));
  expect(unwrap(await nelcota.from("todos").select().execute())).toEqual([{ id: 1 }]);
  const failing = client(json({ code: "invalid_grant", message: "no" }, 400));
  const result = await failing.nelcota.auth.signInWithPassword({
    email: "a@x.com",
    password: "pw",
  });
  expect(() => unwrap(result)).toThrow(expect.objectContaining({ code: "invalid_grant" }));
});

it("reads: throws page errors and refuses pages() outside reads", async () => {
  const { nelcota } = client(json({ code: "rate_limited", message: "slow down" }, 400));
  await expect(async () => {
    for await (const _ of nelcota.from("todos").select().pages(10)) void _;
  }).rejects.toMatchObject({ code: "rate_limited" });
  await expect(nelcota.from("todos").select().pages(0).next()).rejects.toThrow(NelcotaUsageError);
  const head = nelcota.from("todos").select("*", { head: true }) as unknown as {
    pages(size: number): AsyncGenerator;
  };
  await expect(head.pages(1).next()).rejects.toThrow(NelcotaUsageError);
});

it("reads: returns server errors as values", async () => {
  const { nelcota } = client(
    json({ code: "db_error", message: "permission denied for table secrets (42501)" }, 401),
  );
  const { data, error, status } = await nelcota.from("secrets").select().execute();
  expect(data).toBeNull();
  expect(status).toBe(401);
  expect(error).toMatchObject({ name: "NelcotaError", status: 401, code: "db_error" });
});

it("reads: refuses unsafe identifiers before sending", () => {
  const { nelcota, calls } = client(json([]));
  expect(() => nelcota.from("pg_catalog.pg_authid")).toThrow(NelcotaUsageError);
  expect(() =>
    nelcota
      .from("todos")
      .select()
      .eq("id;drop" as "id", 1),
  ).not.toThrow();
  expect(() =>
    nelcota
      .from("todos")
      .select()
      .eq("a,b" as "id", 1),
  ).toThrow(NelcotaUsageError);
  expect(() => nelcota.from("todos").select('id"')).toThrow(NelcotaUsageError);
  expect(() => nelcota.from("todos").select().order("id.desc")).toThrow(NelcotaUsageError);
  expect(() => nelcota.from("todos").select().limit(-1)).toThrow(NelcotaUsageError);
  expect(() => nelcota.from("todos").select().range(5, 4)).toThrow(NelcotaUsageError);
  expect(calls).toHaveLength(0);
});

it("writes: insert sends rows with return=minimal, select() asks for them back", async () => {
  const { nelcota, calls } = client(empty(201), json([{ id: 1, title: "a" }], 201));
  expect(
    (
      await nelcota
        .from("todos")
        .insert([{ title: "a" }, { title: "b" }])
        .execute()
    ).data,
  ).toBeNull();
  expect(requiredValue(calls[0], "recorded test item").headers.get("prefer")).toBe(
    "return=minimal",
  );
  expect(requiredValue(calls[0], "recorded test item").body).toBe('[{"title":"a"},{"title":"b"}]');

  const { data } = await nelcota
    .from("todos")
    .insert({ title: "a" })
    .select("id,title")
    .single()
    .execute();
  expect(data).toEqual({ id: 1, title: "a" });
  expect(requiredValue(calls[1], "recorded test item").headers.get("prefer")).toBe(
    "return=representation",
  );
  expect(query(requiredValue(calls[1], "recorded test item").url)).toEqual([
    ["select", "id,title"],
  ]);
});

it("writes: upsert names the conflict columns and the resolution", async () => {
  const { nelcota, calls } = client(empty(201));
  await nelcota
    .from("products")
    .upsert({ slug: "pen" }, { onConflict: ["slug", "shop"], ignoreDuplicates: true })
    .execute();
  expect(query(requiredValue(calls[0], "recorded test item").url)).toEqual([
    ["on_conflict", "slug,shop"],
  ]);
  expect(requiredValue(calls[0], "recorded test item").headers.get("prefer")).toBe(
    "return=minimal,resolution=ignore-duplicates",
  );
});

it("writes: update and delete carry their filters", async () => {
  const { nelcota, calls } = client(empty(204));
  await nelcota.from("todos").update({ done: true }).eq("id", 3).execute();
  await nelcota.from("todos").delete().in("id", [1, 2]).execute();
  expect(calls.map((c) => [c.method, c.url.search])).toEqual([
    ["PATCH", "?id=eq.3"],
    ["DELETE", "?id=in.%28%221%22%2C%222%22%29"],
  ]);
  expect(requiredValue(calls[0], "recorded test item").body).toBe('{"done":true}');
});

it("writes: refuses malformed writes before sending", () => {
  const { nelcota } = client(empty());
  expect(() => nelcota.from("todos").insert([])).toThrow(NelcotaUsageError);
  expect(() => nelcota.from("todos").update([] as never)).toThrow(NelcotaUsageError);
  expect(() => nelcota.from("todos").upsert({}, { onConflict: "a b" })).toThrow(NelcotaUsageError);
});

it("rpc: posts named arguments and reads the result", async () => {
  const { nelcota, calls } = client(json(12), empty(204));
  expect(await nelcota.rpc("add", { a: 2 })).toEqual({ data: 12, error: null, status: 200 });
  expect(requiredValue(calls[0], "recorded test item").url.pathname).toBe("/rest/v1/rpc/add");
  expect(requiredValue(calls[0], "recorded test item").body).toBe('{"a":2}');
  expect((await nelcota.rpc("nothing")).data).toBeNull();
  expect(requiredValue(calls[1], "recorded test item").body).toBe("{}");
});

it.each([null, 1, "row", []])("row representations: refuses a non-object row %j", async (row) => {
  const { nelcota, calls } = client(() => json([row]));
  try {
    expect((await nelcota.from("notes").select().execute()).error?.code).toBe("invalid_response");
    expect((await nelcota.from("notes").select().single().execute()).error?.code).toBe(
      "invalid_response",
    );
    await expect(nelcota.from("notes").select().pages(10).next()).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(calls).toHaveLength(3);
  } finally {
    nelcota.dispose();
  }
});

it("row representations: retains empty results and nullable fields", async () => {
  const { nelcota } = client(json([]), json([{ field: null }]));
  try {
    expect((await nelcota.from("notes").select().maybeSingle().execute()).data).toBeNull();
    expect((await nelcota.from("notes").select().single().execute()).data).toEqual({
      field: null,
    });
  } finally {
    nelcota.dispose();
  }
});
