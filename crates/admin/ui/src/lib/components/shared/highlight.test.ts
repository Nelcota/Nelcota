import { expect, it } from "vitest";

import { highlight, type CodeLang } from "./highlight";

it.each([
  [
    "import { createClient } from '@nelcota/client'\nconst client = createClient<Database>('http://localhost:8000')",
    "ts",
  ],
  ["curl -X POST 'http://x/rest/v1/todos' \\\n  -H 'Content-Type: application/json' # note", "sh"],
  ["(owner = auth.uid()) AND exists (select 1)\r\n", "sql"],
  ["NELCOTA_SMTP_URL=\n# comment\nNELCOTA_SIGNUP_ENABLED=true", "env"],
  ["unterminated 'string", "ts"],
  ["<script>alert(1)</script>\n\n", "ts"],
] as const)("Shiki code blocks: preserves exact source text for %s", async (code, lang) => {
  expect((await highlight(code, lang)).map((token) => token.text).join("")).toBe(code);
});

it("Shiki code blocks: recognizes TypeScript syntax, URLs in strings, and comments", async () => {
  const tokens = await highlight("const value = fetch('http://a') // done", "ts");
  expect(tokens.some((token) => token.kind === "keyword" && token.text.includes("const"))).toBe(
    true,
  );
  expect(tokens.some((token) => token.kind === "string" && token.text.includes("http://a"))).toBe(
    true,
  );
  expect(tokens.some((token) => token.kind === "comment" && token.text.includes("// done"))).toBe(
    true,
  );
});

it("Shiki code blocks: carries grammar state through multiline comments", async () => {
  const tokens = await highlight("/* first\n second */\nconst count = 2", "ts");
  expect(tokens.some((token) => token.kind === "comment" && token.text.includes("second"))).toBe(
    true,
  );
  expect(tokens.some((token) => token.kind === "number" && token.text.includes("2"))).toBe(true);
});

it.each(["sh", "sql", "env"] as CodeLang[])(
  "Shiki code blocks: loads only supported browser grammars (%s)",
  async (lang) => {
    const code = {
      sh: "printf 'hello' # comment",
      sql: "SELECT 42 -- comment",
      env: 'URL="hello"\n# comment',
    }[lang as "sh" | "sql" | "env"];
    const tokens = await highlight(code, lang);
    expect(tokens.some((token) => token.kind === "comment")).toBe(true);
    expect(tokens.map((token) => token.text).join("")).toBe(code);
  },
);
