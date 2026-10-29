import type { Column } from "$lib/contracts/types";
import { describe, expect, it } from "vitest";

import { requiredValue } from "../../../contracts/required-value.js";
import { fieldProblem, initialFields, rowPayload } from "./row-form";

const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({
  name,
  type,
  full_type: type,
  category: "S",
  nullable: true,
  has_default: false,
  generated: false,
  enum_values: [],
  is_pk: false,
  comment: null,
  references: null,
  ...extra,
});

const columns = [
  col("id", "bigint", { generated: true, is_pk: true, nullable: false, has_default: true }),
  col("name", "text", { nullable: false }),
  col("extra", "jsonb"),
  col("created_at", "timestamp with time zone", { nullable: false, has_default: true }),
];
const row = { id: "1", name: "Ana", extra: null, created_at: "2026-10-06T22:26:15+00:00" };

describe("initial fields", () => {
  it("from the row, with NULL ticked; empty on insert", () => {
    expect(initialFields(columns, row).extra).toEqual({ value: "", isNull: true });
    expect(initialFields(columns, null).name).toEqual({ value: "", isNull: false });
  });
});

describe("validation", () => {
  it("invalid JSON", () => {
    expect(
      fieldProblem(
        requiredValue(columns[2], "test fixture item"),
        { value: "{a:1}", isNull: false },
        false,
      ),
    ).toBe("invalidJson");
    expect(
      fieldProblem(
        requiredValue(columns[2], "test fixture item"),
        { value: '{"a":1}', isNull: false },
        false,
      ),
    ).toBeNull();
  });

  it("required only on insert, without DEFAULT and NULL", () => {
    expect(
      fieldProblem(
        requiredValue(columns[1], "test fixture item"),
        { value: "", isNull: false },
        true,
      ),
    ).toBe("required");
    expect(
      fieldProblem(
        requiredValue(columns[3], "test fixture item"),
        { value: "", isNull: false },
        true,
      ),
    ).toBeNull();
    expect(
      fieldProblem(
        requiredValue(columns[1], "test fixture item"),
        { value: "", isNull: false },
        false,
      ),
    ).toBeNull();
  });
});

describe("what goes to the server", () => {
  it.each([false, true])("preserves a __proto__ column in %s update mode", (editing) => {
    const special = [col("__proto__", "text"), col("constructor", "text")];
    const original = editing
      ? Object.fromEntries([
          ["__proto__", "before"],
          ["constructor", "old"],
        ])
      : null;
    const fields = initialFields(special, original);
    for (const column of special) {
      fields[column.name] = {
        value: column.name === "constructor" ? "new" : "after",
        isNull: false,
      };
    }
    const payload = rowPayload(special, fields, original);
    expect(Object.hasOwn(payload, "__proto__")).toBe(true);
    const serialized = JSON.stringify(payload);
    expect(JSON.parse(serialized)).toEqual(JSON.parse('{"__proto__":"after","constructor":"new"}'));
  });

  it("preserves explicit NULL for a __proto__ column", () => {
    const special = [col("__proto__", "text")];
    const fields = initialFields(special, null);
    fields.__proto__ = { value: "", isNull: true };
    expect(JSON.stringify(rowPayload(special, fields, null))).toBe('{"__proto__":null}');
  });

  it("edit: only what really changed", () => {
    const fields = initialFields(columns, row);
    fields.name = { value: "Ana", isNull: false }; // typed and went back to the original
    fields.extra = { value: '{"vip":true}', isNull: false };
    expect(rowPayload(columns, fields, row)).toEqual({ extra: '{"vip":true}' });
  });

  it("edit: ticking NULL sends null", () => {
    const fields = initialFields(columns, row);
    fields.name = { value: "Ana", isNull: true };
    expect(rowPayload(columns, fields, row)).toEqual({ name: null });
  });

  it("insert: empty is left out (DEFAULT), explicit NULL is sent, generated never", () => {
    const fields = initialFields(columns, null);
    fields.name = { value: "Bruno", isNull: false };
    fields.extra = { value: "", isNull: true };
    fields.id = { value: "99", isNull: false };
    expect(rowPayload(columns, fields, null)).toEqual({ name: "Bruno", extra: null });
  });
});
