import { StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

// Underlines where Postgres says a statement failed. The mark goes away on the
// next edit: it describes the text that ran, not the text being written.

/** Offset in the document (0-based), or `null` to clear. */
export const setErrorAt = StateEffect.define<number | null>();

const WORD = /[\w$."]/;

/** The token Postgres points at: from the offset to the end of the word. */
export function errorRange(doc: Text, at: number): { from: number; to: number } {
  const from = Math.max(0, Math.min(at, doc.length - 1));
  const line = doc.lineAt(from);
  let to = from;
  while (to < line.to && WORD.test(doc.sliceString(to, to + 1))) to++;
  // Punctuation or a lone character: mark at least one character.
  if (to === from) to = Math.min(from + 1, doc.length);
  return { from, to };
}

const line = Decoration.line({ class: "cm-sql-error-line" });
const mark = Decoration.mark({ class: "cm-sql-error" });

export const errorMarker = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorAt) === false) continue;
      if (effect.value === null || tr.state.doc.length === 0) return Decoration.none;
      const { from, to } = errorRange(tr.state.doc, effect.value);
      return Decoration.set([line.range(tr.state.doc.lineAt(from).from), mark.range(from, to)]);
    }
    return tr.docChanged ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});
