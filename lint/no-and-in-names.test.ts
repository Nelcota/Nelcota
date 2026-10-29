import { describe, expect, test } from "bun:test";

import { countRuleErrorsByFile } from "./rule-runner.ts";

const ACCEPTED_CODE = [
  "export default function () {}",
  "export default class { run() {} }",
  "class Order { totalAndCount = 0 }",
  "const tools = { [readAndWrite]() {} };",
  "function validateOrder() {}",
  "function handleCandidate() {}",
  "function expandRange() {}",
  "const brandName = 'Nelcota';",
  "const validateAndSaveLabel = 'Save';",
  "class Order { standardize() {} }",
  "const tools = { landscape() {} };",
];

const REPORTED_CODE = [
  "class Order { loadAndSave = () => {} }",
  "class Order { #readAndWrite() {} }",
  'const tools = { ["readAndWrite"]() {} };',
  "function validateAndSave() {}",
  "const fetchAndParse = async () => {};",
  "const loadAndRender = function () {};",
  "class Order { calculateAndApplyDiscount() {} }",
  "const tools = { readAndWrite() {} };",
  "const tools = { readAndWrite: () => {} };",
  "function parse_and_store() {}",
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
  pluginFile: "no-and-in-names.js",
  ruleId: "naming/no-and-in-names",
  cases: [...acceptedCases, ...reportedCases],
});

describe("no-and-in-names", () => {
  test.each(acceptedCases)("accepts $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(0);
  });

  test.each(reportedCases)("reports $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(1);
  });
});
