import { describe, expect, it } from "vitest";

import { HiddenColumns } from "./hidden-columns.svelte";

describe("hidden columns", () => {
  it("ocultar, mostrar, alternar e mostrar todas", () => {
    const hidden = new HiddenColumns();
    hidden.load("orders");
    hidden.hide("criado_em");
    hidden.hide("criado_em");
    expect(hidden.names).toEqual(["criado_em"]);
    hidden.toggle("status");
    expect(hidden.has("status")).toBe(true);
    hidden.toggle("status");
    expect(hidden.has("status")).toBe(false);
    hidden.showAll();
    expect(hidden.names).toEqual([]);
  });

  it("forgets columns that no longer exist", () => {
    const hidden = new HiddenColumns();
    hidden.load("orders");
    hidden.hide("antiga");
    hidden.hide("total");
    hidden.prune(["id", "total"]);
    expect(hidden.names).toEqual(["total"]);
  });

  it("keeps a list per table (starts empty without localStorage)", () => {
    const hidden = new HiddenColumns();
    hidden.load("clientes");
    expect(hidden.names).toEqual([]);
  });
});
