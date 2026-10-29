// Overview page and the 404 page.
import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/workspace/overview";

const en: Messages<typeof ptBR> = {
  title: "Overview",
  quickActions: "Project quick actions",
  resources: "Project resources",
  description: "Your project is live.",
  period: {
    label: "Period",
    hour: "1 hour",
    day: "24 hours",
    textHour: "Last hour",
    textDay: "Last 24 hours",
    since: "counted since {date}",
  },
  filters: { label: "Series", all: "All", requests: "Requests", refused: "Refused" },
  download: "Download CSV",
  open: "Open",
  rows: {
    title: "Rows per table",
    detail: "{percent}% of the rows · {protection}",
    empty: "No tables yet.",
  },
  blocked: {
    title: "Recently blocked",
    who: "Who",
    where: "Where",
    when: "When",
    none: "No call refused.",
  },
  needs: {
    title: "Needs you",
    allGood: "No table is exposed or locked",
  },
  hero: {
    requests: "Requests in the period",
    refused: "Refused",
    errors: "Server errors",
    ofTotal: "of {whole} · {percent}",
    share: "{part} of {whole} ({percent})",
  },
  cards: {
    database: "Database",
    tablesCaption: { one: "{count} protected", other: "{count} protected" },
    usersCaption: {
      one: "{count} signed in from the app",
      other: "{count} signed in from the app",
    },
    tables: "Tables",
    tablesRing: "{percent}% of tables protected",
    users: "Users",
    usersRing: "{percent}% of users have signed in from the app",
    refused: "Refused",
    refusedBars: "Refused across the period: {total}",
    open: "Open {page}",
  },
  traffic: {
    title: "API traffic",
    requests: "Requests",
    refused: "Refused",
    p95: "p95 {ms} ms",
    p95Title: "95% of responses within {ms} ms",
    chartLabel: "Requests and refused calls over time. Use the arrow keys to move along.",
    range: "Period",
    hour: "1 h",
    day: "24 h",
    since: "Counted since {date}. Restarting the server resets the count.",
    empty: "No requests yet. Connect an app from the API page to see traffic here.",
    showTable: "Show as a table",
    hideTable: "Hide table",
    time: "Time",
    latency: "p95 (ms)",
  },
  journey: {
    title: "Project journey",
    setup: "Initial setup: {done} of {total} observed steps",
    verify: "Verify access from your application",
    verifyHint:
      "A successful sign-in does not prove that reads and writes pass your grants and row policies. Test a permitted operation and a denied operation with different users.",
    access: "Preview table access",
    accessHint:
      "Open a table and use View as to compare a visitor and a selected user. The administrator view bypasses row policies.",
    continue: "Continue to deployment and recovery",
    review: "Review required",
    migrate: "Version your schema",
    migrateHint:
      "Export panel changes, commit the complete migrations folder, preview it and apply it to the intended environment.",
    publish: "Prepare publication",
    publishHint:
      "Choose the target environment, configure its backup agent and use a scoped deployment token. Check status after applying migrations.",
    recover: "Prepare recovery",
    recoverHint:
      "Choose a verified database/file pair, retain the current state and check application data after restoration. This panel has not certified an off-host restore.",
    openMigrations: "Review migrations",
    openDeployment: "Prepare deployment",
    openRecovery: "Review recovery steps",
  },
  steps: {
    title: "Next steps",
    progress: "{done} of {total}",
    hide: "Hide",
    done: "Done",
    table: {
      label: "Create your first table",
      hint: "Where your app keeps its data.",
      action: "Create table",
    },
    protect: {
      label: "Protect your data",
      hint: "Decide who can see and change each table.",
      action: "Review access",
    },
    user: {
      label: "Create a user",
      hint: "An account to try your app’s sign-in.",
      action: "Create user",
    },
    connect: {
      label: "Sign in through the API",
      hint: "Completes when an API sign-in is observed. Data access still needs verification in your app.",
      action: "See how",
    },
  },
  attention: {
    exposed: "Access without per-user protection on {table}",
    exposedHint:
      "Roles with a GRANT may access data without the caller’s row policies. Review permissions and view privileges.",
    blocked: "{table} is locked",
    blockedHint: "Protection is on but has no rules: nobody gets in through the API.",
    protect: "Protect",
    addRule: "Add a rule",
  },
  summary: {
    tables: { one: "{count} table", other: "{count} tables" },
    users: { one: "{count} user", other: "{count} users" },
    policies: { one: "{count} access rule", other: "{count} access rules" },
    functions: { one: "{count} function", other: "{count} functions" },
  },
  tables: {
    heading: "Tables",
    empty: "No tables yet",
    emptyBefore: "Create them with",
    emptyMiddle: "or in the",
    table: "Table",
    rows: "Rows",
    protection: "Protection",
    view: "view",
  },
  notFound: {
    title: "Page not found",
    description: "This address does not exist in this panel.",
    back: "Back to the overview",
    search: "Search the panel",
  },
};

export default en;
