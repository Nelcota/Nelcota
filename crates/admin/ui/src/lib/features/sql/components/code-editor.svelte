<script module lang="ts">
  export interface Cursor {
    line: number;
    column: number;
    /** Selected range; `from === to` when nothing is selected. */
    from: number;
    to: number;
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { basicSetup } from "codemirror";
  import { EditorView, keymap } from "@codemirror/view";
  import { Compartment, EditorState, Prec } from "@codemirror/state";
  import { indentWithTab } from "@codemirror/commands";
  import { sql, PostgreSQL } from "@codemirror/lang-sql";
  import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
  import { tags as t } from "@lezer/highlight";
  import { functionCalls } from "./function-calls";
  import { errorMarker, setErrorAt } from "./error-marker";

  let {
    value = $bindable(""),
    schema = {},
    defaultSchema = "public",
    errorAt = null,
    onrun,
    oncursor,
  }: {
    value?: string;
    /** `{ "table": ["col", ...], "auth.users": [...] }` for autocomplete. */
    schema?: Record<string, string[]>;
    defaultSchema?: string;
    /** Where the last run failed (0-based offset), underlined until the next edit. */
    errorAt?: number | null;
    onrun: () => void;
    /** Cursor line/column and the selected range (empty when nothing is selected). */
    oncursor?: (cursor: Cursor) => void;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | undefined;
  const language = new Compartment();

  // Theme colours come from the panel's CSS variables: they follow light/dark.
  const theme = EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "14px",
      backgroundColor: "transparent",
      color: "var(--foreground)",
    },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.75" },
    ".cm-content": { padding: "12px 0", caretColor: "var(--foreground)" },
    ".cm-line": { padding: "0 16px 0 8px" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--muted-foreground)",
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 16px",
      minWidth: "3em",
      opacity: "0.6",
    },
    ".cm-lineNumbers .cm-gutterElement.cm-activeLineGutter": {
      color: "var(--foreground)",
      opacity: "1",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "color-mix(in oklch, var(--foreground) 4%, transparent)",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in oklch, var(--foreground) 18%, transparent) !important",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-matchingBracket": {
      backgroundColor: "color-mix(in oklch, var(--foreground) 15%, transparent)",
      outline: "none",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--popover)",
      color: "var(--popover-foreground)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "var(--elev-overlay)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "var(--font-mono)",
      fontSize: "13px",
      maxHeight: "18em",
      padding: "4px",
    },
    ".cm-tooltip-autocomplete > ul > li": { padding: "5px 10px !important", borderRadius: "6px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--accent)",
      color: "var(--foreground)",
    },
    ".cm-completionDetail": {
      color: "var(--muted-foreground)",
      fontStyle: "normal",
      marginLeft: "8px",
    },
    // Also over the keyword colour of built-ins such as `count(`.
    ".cm-sql-call, .cm-sql-call *": { color: "var(--syntax-function)" },
    ".cm-sql-error": {
      textDecoration: "underline wavy var(--destructive)",
      textUnderlineOffset: "3px",
    },
    ".cm-sql-error-line": {
      backgroundColor: "color-mix(in oklch, var(--destructive) 8%, transparent)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--muted)",
      border: "none",
      color: "var(--muted-foreground)",
    },
  });

  // Syntax colours come from the --syntax-* tokens (light and dark, D92);
  // table and column names keep the text colour.
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--syntax-keyword)" },
    {
      tag: [t.standard(t.name), t.function(t.variableName), t.function(t.name)],
      color: "var(--syntax-function)",
    },
    { tag: t.typeName, color: "var(--syntax-type)" },
    { tag: [t.string, t.special(t.string)], color: "var(--syntax-string)" },
    { tag: [t.number, t.bool, t.null], color: "var(--syntax-number)" },
    {
      tag: [t.comment, t.lineComment, t.blockComment],
      color: "var(--syntax-comment)",
      fontStyle: "italic",
    },
    { tag: [t.operator, t.punctuation, t.bracket], color: "var(--muted-foreground)" },
    // Plain identifiers carry no colour of their own, so function calls
    // (`functionCalls`) can tint them.
    { tag: t.special(t.name), color: "var(--foreground)" },
  ]);

  const sqlExtension = () =>
    sql({ dialect: PostgreSQL, schema, defaultSchema, upperCaseKeywords: false });

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  onrun();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([indentWithTab]),
          language.of(sqlExtension()),
          syntaxHighlighting(highlight),
          functionCalls,
          errorMarker,
          theme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": "Editor SQL" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) value = update.state.doc.toString();
            if (update.docChanged || update.selectionSet) report(update.state);
          }),
        ],
      }),
    });
    view.focus();
    report(view.state);
    return () => view?.destroy();
  });

  function report(state: EditorState) {
    const { from, to, head } = state.selection.main;
    const line = state.doc.lineAt(head);
    oncursor?.({ line: line.number, column: head - line.from + 1, from, to });
  }

  // A new failure position underlines it and brings it into view.
  $effect(() => {
    const at = errorAt;
    if (view === undefined) return;
    view.dispatch({
      effects: [
        setErrorAt.of(at),
        ...(at === null
          ? []
          : [EditorView.scrollIntoView(Math.min(at, view.state.doc.length), { y: "center" })]),
      ],
    });
  });

  // Schema loaded later (autocomplete) or text replaced from outside (history).
  $effect(() => {
    void schema;
    view?.dispatch({ effects: language.reconfigure(sqlExtension()) });
  });
  $effect(() => {
    if (view != null && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  });
</script>

<div bind:this={host} class="h-full min-h-0 overflow-hidden"></div>
