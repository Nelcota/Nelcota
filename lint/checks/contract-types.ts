import { access } from "node:fs/promises";

const generated = new URL(
  "../../sdk/typescript/test/contract/generated/database.ts",
  import.meta.url,
);
await access(generated).catch((cause: unknown) => {
  throw new Error(
    "Missing CLI-generated contract types. Run the SDK contract fixture with bun run --cwd sdk/typescript test:contract before the full quality check.",
    { cause },
  );
});
