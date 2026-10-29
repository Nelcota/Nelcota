import { Lexer, type Token, type Tokens, type TokensList } from "marked";

export type TranslationCatalog = Record<string, string>;
type Prose = Tokens.Heading | Tokens.Paragraph | Tokens.Text | Tokens.TableCell;

function inlineText(token: Token): string {
  if (token.type === "codespan" || token.type === "html") return "";
  if ("tokens" in token && token.tokens != null) return token.tokens.map(inlineText).join("");
  if ("text" in token && typeof token.text === "string") return token.text;
  return "";
}

function needsTranslation(text: string): boolean {
  return /\p{L}/u.test(Lexer.lexInline(text).map(inlineText).join(""));
}

/** Visit complete prose fragments, never code blocks or their comments. */
function visit(tokens: Token[], apply: (fragment: Prose) => void) {
  for (const token of tokens) {
    if (
      token.type === "heading" ||
      token.type === "paragraph" ||
      (token.type === "text" && token.tokens != null)
    ) {
      apply(token as Prose);
      continue;
    }
    if (token.type === "table") {
      const table = token as Tokens.Table;
      [...table.header, ...table.rows.flat()].forEach(apply);
      continue;
    }
    if (token.type === "list") {
      (token as Tokens.List).items.forEach((item) => visit(item.tokens, apply));
      continue;
    }
    if (token.type === "blockquote") visit((token as Tokens.Blockquote).tokens, apply);
  }
}

export function proseFragments(markdown: string): string[] {
  const fragments: string[] = [];
  visit(Lexer.lex(markdown), (fragment) => {
    if (needsTranslation(fragment.text)) fragments.push(fragment.text);
  });
  return [...new Set(fragments)];
}

/** Inline code and destinations are part of the contract of a translation. */
function protectedInline(markdown: string) {
  const code: string[] = [];
  const links: string[] = [];
  const tags: string[] = [];
  function walk(tokens: Token[]) {
    for (const token of tokens) {
      if (token.type === "codespan") code.push((token as Tokens.Codespan).text);
      if (token.type === "link" || token.type === "image")
        links.push((token as Tokens.Link | Tokens.Image).href);
      if (token.type === "html") tags.push((token as Tokens.HTML).text);
      if ("tokens" in token && token.tokens != null) walk(token.tokens);
    }
  }
  walk(Lexer.lexInline(markdown));
  // Reordering a sentence may move a code span without changing the example.
  return { code: code.toSorted(), links: links.toSorted(), tags: tags.toSorted() };
}

export function validateTranslations(markdown: string, catalog: TranslationCatalog): string[] {
  const fragments = proseFragments(markdown);
  const current = new Set(fragments);
  const errors: string[] = [];
  for (const fragment of fragments) {
    const translated = catalog[fragment];
    if (typeof translated !== "string" || Boolean(translated.trim()) === false) {
      errors.push(`Missing translation: ${fragment}`);
      continue;
    }
    if (JSON.stringify(protectedInline(fragment)) !== JSON.stringify(protectedInline(translated)))
      errors.push(`Changed inline code or link: ${fragment}`);
  }
  for (const fragment of Object.keys(catalog))
    if (current.has(fragment) === false) errors.push(`Outdated translation: ${fragment}`);
  return errors;
}

function translatedFragment<T extends Prose>(fragment: T, catalog: TranslationCatalog): T {
  if (needsTranslation(fragment.text) === false) return fragment;
  const translated = catalog[fragment.text];
  if (translated === undefined) throw new Error(`Missing guide translation: ${fragment.text}`);
  return { ...fragment, text: translated, tokens: Lexer.lexInline(translated) };
}

function translatedToken(token: Token, catalog: TranslationCatalog): Token {
  if (
    token.type === "heading" ||
    token.type === "paragraph" ||
    (token.type === "text" && token.tokens != null)
  ) {
    return translatedFragment(token as Prose, catalog) as Token;
  }
  if (token.type === "table") {
    const table = token as Tokens.Table;
    return {
      ...table,
      header: table.header.map((cell) => translatedFragment(cell, catalog)),
      rows: table.rows.map((row) => row.map((cell) => translatedFragment(cell, catalog))),
    };
  }
  if (token.type === "list") {
    const list = token as Tokens.List;
    const items = list.items.map((item) => {
      const tokens = translateTokens(item.tokens, catalog);
      return { ...item, tokens };
    });
    return { ...list, items };
  }
  if (token.type === "blockquote") {
    const quote = token as Tokens.Blockquote;
    return { ...quote, tokens: translateTokens(quote.tokens, catalog) };
  }
  return token;
}

/** Return a translated AST while preserving source tokens, links and code examples. */
export function translateTokens(tokens: TokensList, catalog: TranslationCatalog): TokensList;
export function translateTokens(tokens: Token[], catalog: TranslationCatalog): Token[];
export function translateTokens(
  tokens: Token[] | TokensList,
  catalog: TranslationCatalog,
): Token[] | TokensList {
  const translated = tokens.map((token) => translatedToken(token, catalog));
  if ("links" in tokens) return Object.assign(translated, { links: tokens.links });
  return translated;
}
