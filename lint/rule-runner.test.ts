import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toCaseFileName } from "./rule-runner.ts";

describe("toCaseFileName", () => {
  test("returns a nested case name with forward slashes on every platform", () => {
    const directoryPath = join(tmpdir(), "lint-rule-case");
    const reportedPath = join(directoryPath, "reported-5", "helper.js");

    const fileName = toCaseFileName(directoryPath, reportedPath);

    expect(fileName).toBe("reported-5/helper.js");
  });

  test("returns a top-level case name unchanged", () => {
    const directoryPath = join(tmpdir(), "lint-rule-case");
    const reportedPath = join(directoryPath, "helper.js");

    const fileName = toCaseFileName(directoryPath, reportedPath);

    expect(fileName).toBe("helper.js");
  });
});
