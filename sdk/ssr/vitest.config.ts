export default {
  test: {
    maxWorkers: 2,
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
          include: ["test/**/*.integration.test.ts"],
          fileParallelism: false,
          testTimeout: 10000,
        },
      },
    ],
  },
};
