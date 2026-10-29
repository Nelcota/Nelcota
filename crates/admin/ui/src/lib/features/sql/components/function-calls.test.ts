import { describe, expect, it } from "vitest";

import { isCall } from "./function-calls";

describe("isCall", () => {
  it("treats identifiers before ( as calls, spaces allowed", () => {
    expect(isCall("Identifier", "round", "(x, 2)")).toBe(true);
    expect(isCall("Identifier", "my_fn", "  (id)")).toBe(true);
    expect(isCall("Identifier", "calls", ", query")).toBe(false);
  });

  it("treats keywords glued to ( as calls unless they open a clause or list", () => {
    expect(isCall("Keyword", "count", "(*)")).toBe(true);
    expect(isCall("Keyword", "LOWER", "(name)")).toBe(true);
    expect(isCall("Keyword", "count", " (*)")).toBe(false);
    for (const word of ["in", "exists", "VALUES", "over"])
      expect(isCall("Keyword", word, "(1)")).toBe(false);
  });

  it("ignores other tokens", () => {
    expect(isCall("Type", "numeric", "(10, 2)")).toBe(false);
    expect(isCall("String", "'x'", "(")).toBe(false);
  });
});
