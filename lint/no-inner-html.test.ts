import { describe, expect, test } from "bun:test";

import { countRuleErrorsByFile } from "./rule-runner.ts";

const ACCEPTED_CODE = [
  "element[property] = name;",
  "element.textContent = name;",
  "const markup = element.innerHTML;",
  'element.setAttribute("title", name);',
  "logger.write(message);",
];

const REPORTED_CODE = [
  'element["innerHTML"] = name;',
  'element.innerHTML = "";',
  "element.innerHTML = name;",
  "element.innerHTML += name;",
  "element.outerHTML = name;",
  'element.insertAdjacentHTML("beforeend", name);',
  "element.setHTMLUnsafe(name);",
  "document.write(name);",
  "document.writeln(name);",
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
  pluginFile: "no-inner-html.js",
  ruleId: "html/no-inner-html",
  cases: [...acceptedCases, ...reportedCases],
});

describe("no-inner-html", () => {
  test.each(acceptedCases)("accepts $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(0);
  });

  test.each(reportedCases)("reports $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(1);
  });
});
