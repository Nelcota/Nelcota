import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Decoration, type DecorationSet, ViewPlugin, type ViewUpdate } from "@codemirror/view";
const CALL_LOOKAHEAD_CHARS = 64;

// The SQL grammar does not mark function calls: an identifier right before
// "(" (`round(`, `my_fn (`) is one. Built-ins the grammar files as keywords
// (`count(`, `lower(`) count too when the "(" is glued to them, unless the
// keyword opens a clause or a list (`in (`, `exists(`, `values(`).
const call = Decoration.mark({ class: "cm-sql-call" });

const STRUCTURAL = new Set([
  "all",
  "and",
  "any",
  "array",
  "as",
  "check",
  "exists",
  "filter",
  "from",
  "in",
  "into",
  "join",
  "key",
  "not",
  "on",
  "or",
  "over",
  "primary",
  "references",
  "returning",
  "row",
  "select",
  "some",
  "table",
  "unique",
  "using",
  "values",
  "where",
  "with",
  "within",
]);

/** Whether a token (its grammar node name, its text and what follows it) is a function call. */
export function isCall(name: string, word: string, after: string): boolean {
  if (name === "Identifier") return /^\s*\(/.test(after);
  if (name === "Keyword")
    return after.startsWith("(") && STRUCTURAL.has(word.toLowerCase()) === false;
  return false;
}

function decorate(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const { doc } = view.state;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Identifier" && node.name !== "Keyword") return;
        const after = doc.sliceString(
          node.to,
          Math.min(node.to + CALL_LOOKAHEAD_CHARS, doc.length),
        );
        const word = doc.sliceString(node.from, node.to);
        if (isCall(node.name, word, after)) marks.push(call.range(node.from, node.to));
      },
    });
  }
  return Decoration.set(marks, true);
}

export const functionCalls = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = decorate(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
