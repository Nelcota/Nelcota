import { describe, expect, it } from "vitest";

import { access, describePolicy, ownerColumn } from "./plain";

describe("access", () => {
  it("reads grants as plain levels", () => {
    expect(access([])).toEqual({ level: "none", verbs: [] });
    expect(access(["SELECT"])).toEqual({ level: "read", verbs: ["read"] });
    expect(access(["DELETE", "select", "UPDATE", "INSERT"]).level).toBe("full");
    expect(access(["INSERT", "SELECT"])).toEqual({ level: "partial", verbs: ["read", "create"] });
  });
});

describe("ownerColumn", () => {
  it("finds the column compared with auth.uid() as Postgres prints it", () => {
    expect(ownerColumn("(owner = auth.uid())")).toBe("owner");
    expect(ownerColumn("(auth.uid() = user_id)")).toBe("user_id");
    expect(ownerColumn('("Dono" = auth.uid())')).toBe("Dono");
    expect(ownerColumn("(user_id = ( SELECT auth.uid() AS uid))")).toBe("user_id");
    expect(ownerColumn("(owner = auth.uid()) AND (status = 1)")).toBeNull();
    expect(ownerColumn("true")).toBeNull();
    expect(ownerColumn(null)).toBeNull();
  });
});

it("describePolicy: recognizes public and signed-in reading", () => {
  expect(
    describePolicy({
      command: "SELECT",
      roles: ["anon", "authenticated"],
      using: "true",
      check: null,
    }).kind,
  ).toBe("everyoneReads");
  expect(describePolicy({ command: "SELECT", roles: [], using: "(true)", check: null }).kind).toBe(
    "everyoneReads",
  );
  expect(
    describePolicy({ command: "SELECT", roles: ["authenticated"], using: "true", check: null })
      .kind,
  ).toBe("signedInReads");
});

it("describePolicy: recognizes owner rules per command", () => {
  expect(
    describePolicy({
      command: "ALL",
      roles: ["authenticated"],
      using: "(owner = auth.uid())",
      check: "(owner = auth.uid())",
    }),
  ).toEqual({
    kind: "owner",
    command: "all",
    column: "owner",
  });
  expect(
    describePolicy({
      command: "INSERT",
      roles: ["authenticated"],
      using: null,
      check: "(user_id = auth.uid())",
    }),
  ).toMatchObject({
    command: "insert",
  });
  expect(
    describePolicy({
      command: "DELETE",
      roles: ["authenticated"],
      using: "(user_id = auth.uid())",
      check: null,
    }),
  ).toMatchObject({
    command: "delete",
  });
});

it("describePolicy: leaves anything else as a custom rule", () => {
  // Different columns on each side, a public owner rule, extra conditions.
  expect(
    describePolicy({
      command: "UPDATE",
      roles: ["authenticated"],
      using: "(a = auth.uid())",
      check: "(b = auth.uid())",
    }).kind,
  ).toBe("custom");
  expect(
    describePolicy({
      command: "ALL",
      roles: ["anon"],
      using: "(owner = auth.uid())",
      check: null,
    }).kind,
  ).toBe("custom");
  expect(
    describePolicy({
      command: "SELECT",
      roles: ["authenticated"],
      using: "(published AND (owner = auth.uid()))",
      check: null,
    }).kind,
  ).toBe("custom");
  expect(
    describePolicy({
      command: "INSERT",
      roles: ["authenticated"],
      using: "(owner = auth.uid())",
      check: null,
    }).kind,
  ).toBe("custom");
});
