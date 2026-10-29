import { expect, it } from "vitest";

import { requiredValue } from "../../contracts/required-value.js";
import { blankColumn } from "./ddl";
import {
  initialTable,
  tableAccess,
  guidedPolicy,
  columnProblem,
  nameProblem,
  uniquePolicyName,
} from "./guided-access";

it("guided access: keeps private tables protected and unavailable to app roles", () => {
  const draft = initialTable();
  const result = tableAccess(draft, "private", "full");
  expect(result.table.rls).toBe(true);
  expect(result.policies).toEqual([]);
  expect(
    result.table.grants
      .filter((grant) => grant.role !== "service_role")
      .every((grant) => Boolean(grant.privileges.length) === false),
  ).toBe(true);
});

it("guided access: public access stays read-only even after switching from full access", () => {
  const result = tableAccess(initialTable(), "everyone", "full");
  expect(result.policies[0]).toMatchObject({ command: "select", using: "true", check: null });
  expect(result.table.grants.find((grant) => grant.role === "anon")?.privileges).toEqual([
    "select",
  ]);
  expect(result.table.grants.find((grant) => grant.role === "authenticated")?.privileges).toEqual([
    "select",
  ]);
});

it("guided access: adds the owner ID and checks ownership on both reads and writes without mutating the draft", () => {
  const draft = initialTable();
  const result = tableAccess(draft, "owner", "full");
  expect(draft.columns).toHaveLength(3);
  expect(result.table.columns.at(-1)).toMatchObject({
    name: "user_id",
    data_type: "uuid",
    default: "auth.uid()",
    nullable: false,
  });
  expect(result.policies[0]).toMatchObject({
    using: "user_id = auth.uid()",
    check: "user_id = auth.uid()",
    command: "all",
  });
});

it("guided access: reuses an owner ID field and refuses incompatible types", () => {
  const draft = initialTable();
  draft.columns.push({ ...blankColumn(), name: "user_id", data_type: "uuid" });
  const result = tableAccess(draft, "owner", "read");
  expect(result.table.columns.filter((column) => column.name === "user_id")).toHaveLength(1);
  expect(result.table.columns.at(-1)?.default).toBe("auth.uid()");
  requiredValue(draft.columns.at(-1), "required operation value").data_type = "text";
  expect(() => tableAccess(draft, "owner", "read")).toThrow("owner_column_type");
});

it("guided access: quotes owner fields and avoids names already used by policies", () => {
  expect(guidedPolicy("owner", "full", { column: "Owner ID" })?.check).toBe(
    '"Owner ID" = auth.uid()',
  );
  expect(uniquePolicyName("owner_read", ["owner_read", "owner_read_2"])).toBe("owner_read_3");
});

it("guided access: validates the actual Postgres byte limit and duplicate trimmed field names", () => {
  expect(nameProblem("ç".repeat(32))).toBe("long");
  expect(nameProblem(" descrição ")).toBeNull();
  const columns = [
    { ...blankColumn(), name: "title" },
    { ...blankColumn(), name: " title " },
  ];
  expect(columnProblem(columns, 1)).toBe("duplicate");
});
