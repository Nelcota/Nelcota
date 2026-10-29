import { describe, expect, it } from "vitest";

import {
  columnChanges,
  grantChanges,
  policyFields,
  toColumnDef,
  toPolicyDef,
  type ColumnInfo,
} from "./ddl";

const info = (overrides: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name: "body",
  data_type: "text",
  nullable: true,
  default: null,
  identity: null,
  generated: false,
  primary_key: false,
  unique: null,
  references: null,
  comment: null,
  ...overrides,
});

it("difference between columns: no changes, no actions", () => {
  expect(columnChanges(info(), toColumnDef(info()))).toEqual([]);
});

it("difference between columns: each changed field becomes an action, rename last", () => {
  const edited = {
    ...toColumnDef(info()),
    name: "content",
    data_type: "varchar(200)",
    nullable: false,
    default: "''",
    unique: true,
    comment: "main text",
  };
  expect(columnChanges(info(), edited).map((a) => a.action)).toEqual([
    "set_type",
    "set_nullable",
    "set_default",
    "set_unique",
    "set_column_comment",
    "rename_column",
  ]);
});

it("difference between columns: an empty or blank default removes the DEFAULT", () => {
  const edited = { ...toColumnDef(info({ default: "0" })), default: "  " };
  expect(columnChanges(info({ default: "0" }), edited)).toEqual([
    { action: "set_default", column: "body", default: null },
  ]);
});

it("difference between columns: leaves the DEFAULT of identity or generated columns alone", () => {
  const identity = info({ identity: "always" });
  expect(columnChanges(identity, { ...toColumnDef(identity), default: "1" })).toEqual([]);
});

it("difference between columns: foreign key: change, removal and on delete from pg_catalog", () => {
  const fk = info({
    references: { table: "customers", column: "id", on_delete: "set null", constraint: "fk" },
  });
  expect(toColumnDef(fk).references).toEqual({
    table: "customers",
    column: "id",
    on_delete: "set_null",
  });
  expect(columnChanges(fk, toColumnDef(fk))).toEqual([]);
  expect(columnChanges(fk, { ...toColumnDef(fk), references: null })).toEqual([
    { action: "set_reference", column: "body", reference: null },
  ]);
});

describe("GRANTs", () => {
  it("only roles that changed produce an action", () => {
    const before = [
      { role: "anon" as const, privileges: ["select" as const] },
      { role: "authenticated" as const, privileges: [] },
    ];
    expect(
      grantChanges(before, [
        { role: "anon", privileges: ["select"] },
        { role: "authenticated", privileges: ["select", "insert"] },
      ]),
    ).toEqual([
      { action: "set_grants", grant: { role: "authenticated", privileges: ["select", "insert"] } },
    ]);
  });
});

describe("policies", () => {
  it("fields of each command", () => {
    expect(policyFields("select")).toEqual({ using: true, check: false });
    expect(policyFields("insert")).toEqual({ using: false, check: true });
    expect(policyFields("update")).toEqual({ using: true, check: true });
    expect(policyFields("delete")).toEqual({ using: true, check: false });
    expect(policyFields("all")).toEqual({ using: true, check: true });
  });

  it("converts the policy read from Postgres", () => {
    expect(
      toPolicyDef({
        name: "p",
        command: "SELECT",
        roles: ["public"],
        permissive: true,
        using: "(true)",
        check: null,
      }),
    ).toEqual({
      name: "p",
      command: "select",
      roles: [],
      permissive: true,
      using: "(true)",
      check: null,
    });
  });

  it("refuses a policy with a role the form would drop", () => {
    const policy = { name: "p", command: "SELECT", permissive: true, using: "(true)", check: null };
    expect(toPolicyDef({ ...policy, roles: ["editor"] })).toBeNull();
    expect(toPolicyDef({ ...policy, roles: ["authenticated", "editor"] })).toBeNull();
  });
});
