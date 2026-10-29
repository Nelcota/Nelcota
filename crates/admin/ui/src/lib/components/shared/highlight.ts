import type { HighlighterCore } from "shiki/core";

import { requiredValue } from "../../contracts/required-value.js";

export type CodeLang = "ts" | "sh" | "sql" | "env";
type TokenKind = "keyword" | "function" | "type" | "string" | "number" | "comment";
export interface Token {
  text: string;
  kind?: TokenKind;
}

let highlighter: Promise<HighlighterCore> | undefined;
function engine() {
  return (highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark.mjs"),
    import("shiki/langs/typescript.mjs"),
    import("shiki/langs/bash.mjs"),
    import("shiki/langs/sql.mjs"),
    import("shiki/langs/dotenv.mjs"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme, ...languages]) =>
    createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      themes: [theme.default],
      langs: languages.map((language) => language.default),
    }),
  ));
}

function kind(scopes: string[]): TokenKind | undefined {
  for (const scope of scopes.toReversed()) {
    if (scope.startsWith("comment")) return "comment";
    if (scope.startsWith("string")) return "string";
    if (/^(keyword|storage)/.test(scope)) return "keyword";
    if (/^(entity.name.function|support.function)/.test(scope)) return "function";
    if (/^(entity.name.type|entity.name.class|support.type|support.class)/.test(scope))
      return "type";
    if (scope.startsWith("constant.numeric")) return "number";
  }
}

/** TextMate grammars, rendered as escaped Svelte text rather than HTML. */
export async function highlight(code: string, lang: CodeLang): Promise<Token[]> {
  const shiki = await engine();
  const language = { ts: "typescript", sh: "bash", sql: "sql", env: "dotenv" }[lang];
  const lines = shiki.codeToTokensBase(code, {
    lang: language,
    theme: "github-dark",
    includeExplanation: "scopeName",
  });
  const endings = code.match(/\r\n|\n|\r/g) ?? [];
  const output: Token[] = [];
  const push = (text: string, tokenKind?: TokenKind) => {
    const last = output.at(-1);
    if (last != null && last.kind === tokenKind) {
      last.text += text;
      return;
    }
    output.push(tokenKind != null ? { text, kind: tokenKind } : { text });
  };
  lines.forEach((line, index) => {
    for (const token of line)
      push(
        token.content,
        kind(
          token.explanation?.flatMap((part) => part.scopes.map((scope) => scope.scopeName)) ?? [],
        ),
      );
    if (index < endings.length) push(requiredValue(endings[index], "bounded operation item"));
  });
  return output;
}
