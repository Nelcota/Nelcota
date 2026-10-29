import { expect, it } from "vitest";

import { findExecutable } from "../../scripts/cargo-artifacts.js";

const artifact = (name: string, executable: string | null) =>
  JSON.stringify({ reason: "compiler-artifact", target: { name }, executable });

it("returns the executable of the requested target", () => {
  const output = [
    JSON.stringify({ reason: "compiler-message", message: {} }),
    artifact("nelcota-auth", null),
    artifact("sdk-contract-server", "/target/debug/examples/sdk-contract-server"),
    JSON.stringify({ reason: "build-finished", success: true }),
  ].join("\n");
  expect(findExecutable(output, "sdk-contract-server")).toBe(
    "/target/debug/examples/sdk-contract-server",
  );
});

it("ignores artifacts of other targets and libraries without an executable", () => {
  const output = [
    artifact("other-example", "/target/debug/examples/other"),
    artifact("sdk-contract-server", null),
  ].join("\n");
  expect(findExecutable(output, "sdk-contract-server")).toBeUndefined();
});

it.each([
  "null",
  "42",
  '"text"',
  "[]",
  JSON.stringify({ reason: "compiler-artifact", target: "sdk-contract-server", executable: "/x" }),
])("skips a line that is not a compiler artifact object: %s", (line) => {
  expect(findExecutable(line, "sdk-contract-server")).toBeUndefined();
});

it("rejects a blank executable path", () => {
  expect(
    findExecutable(artifact("sdk-contract-server", "  "), "sdk-contract-server"),
  ).toBeUndefined();
});

it("returns undefined for empty output", () => {
  expect(findExecutable("", "sdk-contract-server")).toBeUndefined();
  expect(findExecutable("\n  \n", "sdk-contract-server")).toBeUndefined();
});

it("reports malformed JSON instead of hiding it", () => {
  expect(() => findExecutable("{not json", "sdk-contract-server")).toThrow(SyntaxError);
});
