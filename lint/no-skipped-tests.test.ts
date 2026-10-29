import { describe, expect, test } from "bun:test";

import { countRuleErrorsByFile } from "./rule-runner.ts";

const ACCEPTED_CODE = [
  'test[modifier]("adds", () => {});',
  'test("adds", () => {});',
  'it("adds", () => {});',
  'describe("math", () => {});',
  'test.each([1, 2])("handles %d", () => {});',
  "const options = { skip: true };",
];

const REPORTED_CODE = [
  'test["skip"]("adds", () => {});',
  'test.skip("adds", () => {});',
  'test.only("adds", () => {});',
  'test.todo("adds");',
  'it.skip("adds", () => {});',
  'describe.only("math", () => {});',
  'test.skipIf(isWindows)("adds", () => {});',
  'test.if(isLinux)("adds", () => {});',
  'test.skip.each([1, 2])("handles %d", () => {});',
  'xit("adds", () => {});',
  'fdescribe("math", () => {});',
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
  pluginFile: "no-skipped-tests.js",
  ruleId: "tests/no-skipped-tests",
  cases: [...acceptedCases, ...reportedCases],
});

describe("no-skipped-tests", () => {
  test.each(acceptedCases)("accepts $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(0);
  });

  test.each(reportedCases)("reports $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(1);
  });
});
