const MAX_INDENTATION_DEPTH = 32;

/** Pretty-print valid JSON without converting its number or string tokens. */
export function formatJson(value: string): string {
  JSON.parse(value); // Validate syntax; the parsed values are never serialized.
  const tokens =
    value.match(
      /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g,
    ) ?? [];
  let depth = 0;
  let result = "";
  // Cap visual indentation so a small, deeply nested value cannot expand
  // quadratically. All JSON tokens, including precise numbers, stay intact.
  const newline = () => {
    result += "\n" + "  ".repeat(Math.min(depth, MAX_INDENTATION_DEPTH));
  };
  tokens.forEach((token, i) => {
    if (isOpeningToken(token)) {
      result += token;
      depth++;
      if (isClosingToken(tokens[i + 1]) === false) newline();
      return;
    }
    if (isClosingToken(token)) {
      depth--;
      if (isOpeningToken(tokens[i - 1]) === false) newline();
      result += token;
      return;
    }
    if (token === ",") {
      result += token;
      newline();
      return;
    }
    result += token === ":" ? ": " : token;
  });
  return result;
}

function isOpeningToken(token: string | undefined): boolean {
  return token === "{" || token === "[";
}
function isClosingToken(token: string | undefined): boolean {
  return token === "}" || token === "]";
}
