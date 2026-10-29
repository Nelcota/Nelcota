import { describe, expect, it } from "vitest";

import {
  fixtureArray,
  fixtureErrorCode,
  fixtureObject,
  fixtureString,
} from "../scripts/fixture-values.mjs";

describe("external fixture values", () => {
  it("validates data before scripts read fields", () => {
    const data = { messages: [{ id: "message-1" }] };
    expect(fixtureObject(data)).toBe(data);
    expect(fixtureArray(data.messages)).toBe(data.messages);
    expect(fixtureString("message-1")).toBe("message-1");
  });

  it.each([null, [], "response"])("refuses an invalid object: %j", (value) => {
    expect(() => fixtureObject(value)).toThrow(TypeError);
  });

  it("refuses invalid arrays and strings", () => {
    expect(() => fixtureArray({})).toThrow(TypeError);
    expect(() => fixtureString(undefined)).toThrow(TypeError);
    expect(() => fixtureString(1)).toThrow(TypeError);
  });

  it("reads a typed error code without trusting arbitrary thrown data", () => {
    expect(fixtureErrorCode(Object.assign(new Error("database closed"), { code: "57P01" }))).toBe(
      "57P01",
    );
    expect(fixtureErrorCode({ code: "57P01" })).toBeUndefined();
    expect(fixtureErrorCode(new Error("uncoded"))).toBeUndefined();
  });
});
