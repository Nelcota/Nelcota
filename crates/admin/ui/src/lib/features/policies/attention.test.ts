import type { PoliciesData } from "$lib/contracts/types";
import { describe, expect, it } from "vitest";

import {
  attentionItems,
  byUrgency,
  exposedRelations,
  inFilter,
  OWNER_VIEW_LABEL,
  parseFilter,
  policyStats,
  type PolicyTable,
} from "./attention";

const policy = {
  name: "owner_access",
  permissive: true,
  roles: ["authenticated"],
  command: "ALL",
  using: "owner = auth.uid()",
  check: "owner = auth.uid()",
};

function table(name: string, state: string, patch: Partial<PolicyTable["rls"]> = {}): PolicyTable {
  const policies = state === "ok" ? [policy] : [];
  return {
    name,
    exposed_without_rls: false,
    rls: {
      state,
      label: "RLS",
      enabled: state === "ok" || state === "warn",
      forced: false,
      policies: policies.length,
      ...patch,
    },
    policies,
  } as PolicyTable;
}

function data(tables: PolicyTable[], exposed: string[] = []): PoliciesData {
  return { schema: "public", exposed_without_rls: exposed, anon_functions: [], tables };
}

describe("byUrgency", () => {
  it("puts open tables first, then blocked ones, then the rest by name", () => {
    const sorted = byUrgency([
      table("notes", "ok"),
      table("profiles", "warn"),
      table("audit", "ok"),
      table("orders", "danger"),
    ]);
    expect(sorted.map((item) => item.name)).toEqual(["orders", "profiles", "audit", "notes"]);
  });

  it("does not change the list it receives", () => {
    const input = [table("b", "ok"), table("a", "danger")];
    byUrgency(input);
    expect(input.map((item) => item.name)).toEqual(["b", "a"]);
  });
});

describe("attentionItems", () => {
  it("lists each problem with the fix it needs, most urgent first", () => {
    const items = attentionItems(
      data([table("notes", "ok"), table("profiles", "warn"), table("orders", "danger")]),
    );
    expect(items).toEqual([
      { kind: "unprotected", table: "orders" },
      { kind: "noRules", table: "profiles" },
    ]);
  });

  it("sends owner views to the SQL review instead of turning RLS on", () => {
    const items = attentionItems(
      data([table("owner_todos", "danger", { label: OWNER_VIEW_LABEL, enabled: false })]),
    );
    expect(items).toEqual([{ kind: "ownerView", table: "owner_todos" }]);
  });

  it("adds exposed objects that are not in the table list", () => {
    const items = attentionItems(data([table("orders", "danger")], ["orders", "owner_todos"]));
    expect(items).toEqual([
      { kind: "unprotected", table: "orders" },
      { kind: "relation", table: "owner_todos" },
    ]);
  });

  it("returns nothing when every table is fine", () => {
    expect(attentionItems(data([table("notes", "ok")]))).toEqual([]);
  });
});

describe("exposedRelations", () => {
  it("ignores tables that already appear in the list", () => {
    expect(exposedRelations(data([table("orders", "danger")], ["orders", "report"]))).toEqual([
      "report",
    ]);
  });
});

describe("inFilter", () => {
  const open = table("orders", "danger");
  const blocked = table("profiles", "warn");
  const fine = table("notes", "ok");
  const view = table("summary", "view", { enabled: false });

  it('keeps protected tables under "enabled"', () => {
    expect(
      [open, blocked, fine].filter((item) => inFilter(item, "enabled")).map((item) => item.name),
    ).toEqual(["profiles", "notes"]);
  });

  it('leaves views out of "disabled"', () => {
    expect(
      [open, view].filter((item) => inFilter(item, "disabled")).map((item) => item.name),
    ).toEqual(["orders"]);
  });

  it('keeps open and blocked tables under "attention"', () => {
    expect(
      [open, blocked, fine].filter((item) => inFilter(item, "attention")).map((item) => item.name),
    ).toEqual(["orders", "profiles"]);
  });
});

describe("parseFilter", () => {
  it("accepts known filters and falls back to all", () => {
    expect(parseFilter("disabled")).toBe("disabled");
    expect(parseFilter("nope")).toBe("all");
    expect(parseFilter(null)).toBe("all");
  });
});

describe("policyStats", () => {
  it("counts tables, protected tables and rules without views", () => {
    const stats = policyStats([
      table("orders", "danger"),
      table("notes", "ok"),
      table("profiles", "warn"),
      table("summary", "view", { enabled: false }),
    ]);
    expect(stats).toEqual({ tables: 3, protected: 2, rules: 1 });
  });

  it("returns zeros for an empty schema", () => {
    expect(policyStats([])).toEqual({ tables: 0, protected: 0, rules: 0 });
  });
});
