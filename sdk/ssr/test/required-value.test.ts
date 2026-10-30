import { expect, it } from "vitest";

import { requiredValue } from "./required-value.js";

it.each([null, undefined])("rejects an absent required value (%s)", (value) => {
  expect(() => requiredValue(value, "test field")).toThrow("Missing test field");
});

it.each([false, 0, "", [], {}])("preserves a present value (%s)", (value) => {
  expect(requiredValue(value, "test field")).toBe(value);
});
