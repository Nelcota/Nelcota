import { describe, expect, test } from "bun:test";

import { countRuleErrorsByFile } from "./rule-runner.ts";

const ACCEPTED_CODE = [
  "window.setTimeout(run, timeoutInMs);",
  "async function wait() { await Bun.sleep(RETRY_DELAY_IN_MS); }",
  "setTimeout(run, config[key]);",
  "scheduler.setTimeout(run, 5000);",
  "setTimeout(run, timeoutInMs);",
  "setInterval(run, POLL_INTERVAL_IN_MS);",
  "setTimeout(run, config.retryDelayMs);",
  "AbortSignal.timeout(REQUEST_TIMEOUT_MS);",
  "setTimeout(run, 0);",
  "setTimeout(run);",
  "setTimeout(run, seconds * 1000);",
];

const REPORTED_CODE = [
  "window.setTimeout(run, 5000);",
  "globalThis.setInterval(run, timeout);",
  "self.setTimeout(run, 100);",
  "async function wait() { await Bun.sleep(5000); }",
  'setTimeout(run, config["timeout"]);',
  "setTimeout(run, 5000);",
  "setInterval(run, 60_000);",
  "AbortSignal.timeout(10000);",
  "setTimeout(run, timeout);",
  "AbortSignal.timeout(config.timeout);",
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
  pluginFile: "duration-unit-suffix.js",
  ruleId: "durations/duration-unit-suffix",
  cases: [...acceptedCases, ...reportedCases],
});

describe("duration-unit-suffix", () => {
  test.each(acceptedCases)("accepts $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(0);
  });

  test.each(reportedCases)("reports $code", ({ fileName }) => {
    const errorCount = errorCounts.get(fileName);

    expect(errorCount).toBe(1);
  });
});
