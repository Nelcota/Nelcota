// SQL editor: toolbar, results, saved queries and ready-made templates.
import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/data/sql";

const en: Messages<typeof ptBR> = {
  editor: {
    migrationWarning:
      "SQL editor changes are not recorded as application migrations. Keep schema changes in repository migration files before deploying other environments.",
    newQuery: "New query",
    unsaved: "· unsaved draft",
    unsavedTitle: "Unsaved changes",
    ownerNote: "Run as: full access",
    ownerNoteMore: " · bypasses the rules",
    ownerNoteTitle:
      "Queries run as the database owner: access policies (RLS) do not apply and everything can be read and changed.",
    renameHint: "Click to rename",
    saveHint: "Click to save with a name",
    runSelection: "Run selection",
    errorHere: "Highlighted in the editor, line {line}.",
    open: "Queries and templates",
    drafts: "Drafts",
    localOnly: "Queries and drafts are stored in this browser, for this project.",
    resize: "Resize editor and results",
    discardDraft: "This draft will be removed from this browser. This cannot be undone.",
    saved: "Saved",
    templates: "Templates",
    history: "History",
    recentlyRun: "Recently run",
    saveMore: "More save options",
    saveAsNew: "Save as new…",
    rename: "Rename…",
    run: "Run",
    runTitle: "Run ({shortcut})",
    running: "Running…",
    stop: "Stop",
    stopTitle: "Stop the running query",
    stoppedToast: "Query stopped.",
    savedToast: '"{name}" saved',
    exportBaseName: "result",
  },
  results: {
    label: "SQL query results",
    completed: "Query completed in {ms} ms.",
    emptyTitle: "No results yet",
    emptyDescription: "Write a query and run it.",
    position: "Position {position} in the text.",
    hint: "Hint: {hint}",
    noRows: "Done, no rows",
    noMatchingRows: "The query ran, but no row matched.",
    failed: "The query failed",
    resultOf: "Result {index} of {total}",
    rows: { one: "{count} row", other: "{count} rows" },
    truncated: "(result limited by rows or size)",
    batchTruncated: "Showing the first 32 results. All statements in the batch were processed.",
  },
  dialog: {
    saveTitle: "Save query",
    renameTitle: "Rename query",
    renameConfirm: "Rename",
    description: "Saved in this browser, for this project.",
    placeholder: "e.g. orders this week",
    deleteTitle: 'Delete "{name}"?',
    deleteDescription: "The saved query is removed from this browser. This cannot be undone.",
  },
  sidebar: {
    label: "Saved queries and templates",
    title: "SQL editor",
    savedCount: "Saved ({count})",
    noSaved: "No saved queries.",
    localOnly: "Kept in this browser",
    actionsFor: "Actions for {name}",
    discardDraft: "Discard the draft {name}",
    rename: "Rename",
  },
  title: {
    read: "Query on {target}",
    insert: "Insert into {target}",
    update: "Update {target}",
    delete: "Delete from {target}",
    create: "Create {target}",
    alter: "Alter {target}",
    drop: "Drop {target}",
    empty: "Empty query",
  },
  runAs: {
    label: "Run as",
    owner: "Database owner",
    ownerHint: "Full access: bypasses the access rules",
    anon: "Visitor",
    anonHint: "No sign-in: what anyone sees through the API",
    authenticated: "Signed-in user…",
    authenticatedHint: "What a specific user sees through the API",
    asVisitor: "As a visitor",
    asUser: "As {email}",
    pickTitle: "Run as which user?",
    search: "Search by email",
    empty: "No users found",
    noUsers: "No users yet. Create one to test as them.",
    loading: "Loading…",
  },
  status: {
    position: "Line {line}, column {column}",
    selected: { one: "{count} character selected", other: "{count} characters selected" },
    run: "{shortcut} runs",
    runSelection: "{shortcut} runs the selection",
    limits: "Limit of 30 s and 1000 rows per result",
  },
  snippets: {
    rlsTable: {
      label: "Create a table with RLS",
      sql: `create table public.notes (
  id bigint generated always as identity primary key,
  owner uuid not null default auth.uid(),
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.notes enable row level security;

create policy "owner reads and changes their own notes"
  on public.notes for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

grant select, insert, update, delete on public.notes to authenticated;`,
    },
    tablesWithoutRls: {
      label: "List tables without RLS",
      sql: `select c.relname as table_name, c.relrowsecurity as rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity, c.relname;`,
    },
    recentUsers: {
      label: "Recent users",
      sql: `select id, email, created_at, last_sign_in_at
from auth.users
order by created_at desc
limit 20;`,
    },
    slowQueries: {
      label: "Slowest queries",
      sql: `select round(mean_exec_time::numeric, 2) as mean_ms, calls, query
from extensions.pg_stat_statements
order by mean_exec_time desc
limit 20;`,
    },
  },
};

export default en;
