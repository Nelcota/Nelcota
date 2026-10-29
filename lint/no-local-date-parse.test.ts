import { describe, expect, test } from "bun:test";

import { countRuleErrorsByFile } from "./rule-runner.ts";

const ACCEPTED_CODE = [
  "new Date(`2026-10-24T14:30:00Z`);",
  "new Date(`${year}-10-24`);",
  'new Date("2026-10-24T14:30:00Z");',
  'new Date("2026-10-24T14:30:00.123-03:00");',
  'Date.parse("2026-10-24T14:30Z");',
  "new Date(Date.now());",
  "new Date();",
];

const REPORTED_CODE = [
  "new Date(`24/10/2026`);",
  'Date["parse"]("Oct 24, 2026");',
  'new Date("24/10/2026");',
  'new Date("2026-10-24");',
  'new Date("2026-10-24 14:30:00");',
  'new Date("2026-10-24T14:30:00");',
  'Date.parse("Oct 24, 2026");',
  'new Date("");',
];

const acceptedCases = ACCEPTED_CODE.map((code, index) => ({
  fileName: `accepted-${index}.js`,
  code,
}));
const reportedCases = REPORTED_CODE.map((code, index) => ({
  fileName: `reported-${index}.js`,
  code,
}));

const errorCounts = await countRuleErrorsByFile({
  pluginFile: "no-local-date-parse.js",
  ruleId: "dates/no-local-date-parse",
  cases: [...acceptedCases, ...reportedCases],
});

describe("no-local-date-parse", () => {
  test.each(acceptedCases)("accepts $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(0);
  });

  test.each(reportedCases)("reports $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(1);
  });
});
