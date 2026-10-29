import type { KnipConfig } from "knip";
import { svelte2tsx } from "svelte2tsx";

import configuration from "./knip.json" with { type: "json" };
import { sourceEntries } from "./lint/exports/source-entries.ts";
import { stylesheetImports } from "./lint/styles/imports.ts";
import next from "./sdk/nextjs/package.json" with { type: "json" };
import ssr from "./sdk/ssr/package.json" with { type: "json" };
import client from "./sdk/typescript/package.json" with { type: "json" };

const config: KnipConfig = {
  ...configuration,
  workspaces: {
    ...configuration.workspaces,
    "sdk/typescript": {
      ...configuration.workspaces["sdk/typescript"],
      entry: [
        ...configuration.workspaces["sdk/typescript"].entry,
        ...sourceEntries(client.exports),
      ],
    },
    "sdk/nextjs": {
      ...configuration.workspaces["sdk/nextjs"],
      entry: [...configuration.workspaces["sdk/nextjs"].entry, ...sourceEntries(next.exports)],
    },
    "sdk/ssr": {
      ...configuration.workspaces["sdk/ssr"],
      entry: [...configuration.workspaces["sdk/ssr"].entry, ...sourceEntries(ssr.exports)],
    },
  },
  compilers: {
    css: stylesheetImports,
    svelte: (source, filename) => svelte2tsx(source, { filename, isTsFile: true }).code,
  },
};

export default config;
