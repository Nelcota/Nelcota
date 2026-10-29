import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vite.config.ts";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["src/lib/resources/query-client.memory.ts"],
      pool: "forks",
      execArgv: ["--expose-gc"],
    },
  }),
);
