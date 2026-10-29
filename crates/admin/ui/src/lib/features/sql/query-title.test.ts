import { describe, expect, it } from "vitest";

import { queryTitle } from "./query-title";

describe("queryTitle", () => {
  it("names a query by what it reads or changes", () => {
    expect(
      queryTitle("select round(mean_exec_time::numeric, 2)\nfrom extensions.pg_stat_statements"),
    ).toEqual({
      kind: "read",
      target: "extensions.pg_stat_statements",
    });
    expect(queryTitle("SELECT * FROM public.notes WHERE id = 1")).toEqual({
      kind: "read",
      target: "notes",
    });
    expect(queryTitle('insert into "Pedidos" (a) values (1)')).toEqual({
      kind: "insert",
      target: '"Pedidos"',
    });
    expect(queryTitle("update only tasks set done = true")).toEqual({
      kind: "update",
      target: "tasks",
    });
    expect(queryTitle("delete from auth.sessions")).toEqual({
      kind: "delete",
      target: "auth.sessions",
    });
    expect(queryTitle("create table if not exists public.notas (id int)")).toEqual({
      kind: "create",
      target: "notas",
    });
    expect(queryTitle("alter table notes enable row level security")).toEqual({
      kind: "alter",
      target: "notes",
    });
    expect(queryTitle("drop table if exists old_stuff")).toEqual({
      kind: "drop",
      target: "old_stuff",
    });
  });

  it("looks past comments and reads only the first statement", () => {
    expect(queryTitle("-- slowest\n/* note */ select 1 from orders; delete from x")).toEqual({
      kind: "read",
      target: "orders",
    });
  });

  it("falls back when there is nothing to name it by", () => {
    expect(queryTitle("   \n-- only a comment\n")).toEqual({ kind: "empty" });
    expect(queryTitle("select now();")).toEqual({ kind: "other" });
  });
});
