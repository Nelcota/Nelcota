import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "types",
          include: ["test/types/**/*.test-d.ts"],
          typecheck: { enabled: true, only: true, tsconfig: "./test/types/tsconfig.json" },
        },
      },
      {
        // Against a running server: NELCOTA_SDK_TEST_URL and the fixture in
        // test/contract/fixture.sql (scripts/contract.ts sets both up).
        test: {
          name: "contract",
          include: ["test/contract/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 20_000,
        },
      },
    ],
  },
});
