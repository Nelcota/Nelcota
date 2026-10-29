import { expect, it } from "vitest";

import { backupTime } from "./recovery";
it("reads the UTC recovery point only from a valid standard filename", () => {
  expect(backupTime("nelcota-shop-20261006T030000Z.dump")).toBe("2026-10-06T03:00:00.000Z");
});
it.each([
  "legacy.dump",
  "nelcota-shop-20260230T030000Z.dump",
  "nelcota-shop-20261006T250000Z.dump",
])("does not invent a point for %s", (name) => {
  expect(backupTime(name)).toBeNull();
});
