const databaseUrl = [
  process.env["NELCOTA_SSR_TEST_DATABASE_URL"],
  // Previous name, still accepted.
  process.env["NELCOTA_NEXT_TEST_DATABASE_URL"],
].find((value) => value !== undefined && value.trim() !== "");
const ci =
  process.env["CI"] !== undefined && process.env["CI"] !== "" && process.env["CI"] !== "false";
const integrationSelected = process.argv.includes("integration");

// Locally, a missing fixture skips the PostgreSQL suite with a clear message; in CI
// the suite runs anyway so that a missing service fails instead of passing silently.
const runIntegration = databaseUrl !== undefined || ci;
if (runIntegration === false && integrationSelected)
  console.warn(
    "Skipping the PostgreSQL integration suite: set NELCOTA_SSR_TEST_DATABASE_URL (or NELCOTA_NEXT_TEST_DATABASE_URL) to a disposable database, e.g. from scripts/test.sh db.",
  );

export default {
  test: {
    maxWorkers: 2,
    passWithNoTests: runIntegration === false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.integration.test.ts"],
          testTimeout: 10000,
        },
      },
      {
        test: {
          name: "integration",
          include: runIntegration ? ["test/**/*.integration.test.ts"] : [],
          fileParallelism: false,
          testTimeout: 10000,
        },
      },
    ],
  },
};
