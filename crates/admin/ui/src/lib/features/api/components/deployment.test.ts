import { expect, it } from "vitest";

import { deploymentCommands } from "./deployment";
it("pins the full deployment sequence to the chosen environment without credentials", () => {
  const commands = deploymentCommands("https://api.example.test", "staging");
  expect(
    Object.values(commands ?? {})
      .join("\n")
      .split("\n")
      .every((line) => line.includes("--env staging")),
  ).toBe(true);
  expect(commands?.preview).toContain("nelcota migrate --env staging status");
  expect(JSON.stringify(commands)).not.toContain("ndp_");
  expect(commands?.apply).toBe("nelcota migrate --env staging");
  expect(commands?.preview.split("\n")).not.toContain(commands?.apply);
});
it.each(["", "production; echo secret", "$(echo token)", "a".repeat(41)])(
  "refuses unsafe environment input %s",
  (environment) => {
    expect(deploymentCommands("https://api.example.test", environment)).toBeNull();
  },
);
