import { describe, expect, test } from "bun:test";

import { countRuleErrorsByFile } from "./rule-runner.ts";

const ACCEPTED_NAMES = [
  "src/utilities/dates.ts",
  "src/helpful/order.ts",
  "dates.ts",
  "order.service.ts",
  "helpful-tips.ts",
  "utility-bill.ts",
];

const REPORTED_NAMES = [
  "src/utils/dates.ts",
  "src/orders/helpers/order.ts",
  "utils.ts",
  "helpers.ts",
  "Utils.ts",
  "helper.js",
  "order.utils.ts",
  "util.test.ts",
];

// Each name gets its own folder so "utils.ts" and "Utils.ts" do not collide on case-insensitive disks.
function toCases(prefix: string, names: string[]) {
  return names.map((name, index) => ({
    name,
    fileName: `${prefix}-${index}/${name}`,
    code: "export const value = 1;",
  }));
}

const acceptedCases = toCases("accepted", ACCEPTED_NAMES);
const reportedCases = toCases("reported", REPORTED_NAMES);

const errorCounts = await countRuleErrorsByFile({
  pluginFile: "no-generic-helpers.js",
  ruleId: "files/no-generic-helpers",
  cases: [...acceptedCases, ...reportedCases],
});

describe("no-generic-helpers", () => {
  test.each(acceptedCases)("accepts $name", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(0);
  });

  test.each(reportedCases)("reports $name", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(1);
  });
});
