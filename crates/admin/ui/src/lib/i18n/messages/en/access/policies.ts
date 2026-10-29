// Policies page, policy sheet, RLS badge, grants editor and SQL preview.
import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/access/policies";

const en: Messages<typeof ptBR> = {
  previewAccess: "Preview as visitor",
  previewAccessHint:
    "Starts a read-only visitor preview. Use View as to select a user and compare allowed and denied rows; the administrator view bypasses RLS.",
  title: "Policies",
  search: "Search tables",
  filters: {
    all: "All",
    enabled: "Protected",
    disabled: "Unprotected",
    attention: "Needs attention",
  },
  filterEmpty: {
    enabled: {
      title: "No protected table",
      text: "Turn on protection for a table so only its rules decide who gets in.",
    },
    disabled: {
      title: "Every table is protected",
      text: "No table is open to the API without rules.",
    },
    attention: {
      title: "Nothing needs attention",
      text: "No table is unprotected or locked without rules.",
    },
  },
  showAll: "Show all tables",
  summary: {
    protected: {
      one: "{protected} of {count} table protected",
      other: "{protected} of {count} tables protected",
    },
  },
  attention: {
    title: { one: "{count} item needs attention", other: "{count} items need attention" },
    hint: "Fix these so that only the rules decide who reaches the data.",
    unprotected: "Unprotected: anyone with the API address can read and change every row.",
    noRules: "Protected but without rules: nobody gets in through the API until you create one.",
    createRule: "Create rule",
  },
  tables: "Tables",
  count: { one: "{count} access rule", other: "{count} access rules" },
  description: "Who can see and change the data of each table.",
  legend: {
    title: "How to read each table's protection",
    intro:
      "Each access rule is a Postgres policy. Rules only apply while row protection (RLS) is on for the table.",
  },
  exposedRelations:
    "Review {relations} in the SQL editor. Views use owner privileges: set security_invoker = true and check the underlying tables’ policies, or revoke the GRANT. Materialized views and foreign tables need their own access controls.",
  ownerView: "Owner privileges",
  reviewSql: "Open SQL editor",
  ownerViewHint:
    "This view uses owner privileges and may bypass the caller’s RLS. Review security_invoker = true or revoke the GRANT.",
  noTables: "No tables",
  noTablesHint: "Create a table to define access rules on it.",
  enableRls: "Turn on row protection (RLS)",
  enableRlsEmpty: {
    title: "Turn on protection for {table}?",
    description:
      "This table has no access rules yet. With protection on, visitors (anon) and signed-in users (authenticated) get no rows from the API (queries come back empty) until you create a rule. Only your backend (service_role) keeps access.",
    confirm: "Turn on anyway",
  },
  newPolicy: "New rule",
  noPolicies: "No rules.",
  noPoliciesRlsBefore: "No rules: nobody gets in through the API, only your backend (",
  noPoliciesRlsAfter: "). Add an access rule to allow access.",
  restrictiveTag: "(restrictive)",
  editLabel: "Edit {name}",
  customRoles: "This rule uses a role created in SQL: edit it in the SQL editor.",
  deleteLabel: "Delete {name}",
  blocked: {
    title: "Recently blocked",
    hint: "The last {capacity} calls the API refused, kept only until the server restarts.",
    hintMore: "Reads the rules filter do not show here: they come back empty, not refused.",
    updated: "Updated at {time}",
    none: "No call refused since the server started.",
    refresh: "Refresh",
    showAll: { one: "Show {count} block", other: "Show all {count} blocks" },
    showLess: "Show less",
    who: {
      anon: "Visitor",
      invalid_token: "Invalid token",
      service_role: "Your backend (service_role)",
      authenticated: "Signed-in user",
    },
    target: { table: "table {name}", function: "function {name}", bucket: "bucket {name}" },
    reasons: {
      token:
        "The token sent expired or is invalid. The SDK refreshes it by itself; with fetch, the person must sign in again.",
      rateLimited: "Too many attempts in a row: the API asked to wait.",
      files:
        "No access rule of this bucket allows it. The rules are on the bucket's page, under Storage.",
      rls: "An access rule refused this write: the new or changed row does not meet the rules' condition (WITH CHECK).",
      grantAnon:
        "Visitors (anon) have no permission (GRANT) for this. Grant it in the table's Structure tab, if that is the intent.",
      grantUser:
        "Signed-in users (authenticated) have no permission (GRANT) for this. Grant it in the table's Structure tab, if that is the intent.",
      other: "Refused by the API.",
    },
  },
  anonFunctions: "Functions visitors (anon) can execute",
  anonFunctionsHint:
    "By default, Postgres lets anyone execute a new function (EXECUTE to PUBLIC). To restrict it:",
  rlsEnabled: "Protection turned on for {table}",
  deleted: 'Rule "{name}" deleted',
  confirmDelete: {
    title: 'Delete the rule "{name}"?',
    description: "Rows of {table} that only this rule allowed become inaccessible.",
    confirm: "Delete rule",
  },
  sheet: {
    new: "New access rule",
    edit: "Edit access rule",
    onTable: "on table",
    fromTemplate: "Start from a template",
    templatesOwnerColumn: "Owner templates use the column",
    name: "Name",
    namePlaceholder: "e.g. owner reads their own notes",
    command: "Command",
    appliesTo: "Applies to",
    noRoles: "None checked: applies to everyone (PUBLIC).",
    restrictive: "Restrictive",
    restrictiveHint:
      "Permissive rules add up (one allowing is enough). Restrictive ones are required on top.",
    usingSees: "which existing rows the role can see",
    usingDeletes: "which existing rows the role can delete",
    checkHint: "which new or changed rows are accepted",
    checkPlaceholder: "empty = same rule as USING",
    helpBefore: "Use",
    helpMiddle: "for the signed-in user id and",
    helpAfter: "for the token claims.",
    previewPlaceholder: "Give it a name and write the expression to see the SQL.",
    savePolicy: "Save rule",
    createPolicy: "Create rule",
    saved: 'Rule "{name}" saved',
    commands: {
      select: "SELECT (read)",
      insert: "INSERT (create)",
      update: "UPDATE (change)",
      delete: "DELETE (delete)",
      all: "ALL (everything)",
    },
    roles: {
      anon: "not signed in",
      authenticated: "signed in",
      service_role: "backend",
    },
  },
  rls: {
    none: "no RLS",
    noPolicies: "RLS without policies",
    policies: { one: "RLS, {count} policy", other: "RLS, {count} policies" },
    noGrants: "no RLS, no grants",
    view: "view",
  },
  grants: {
    role: "Role",
    privilegeFor: "{privilege} for {role}",
    hints: {
      anon: "requests without a token",
      authenticated: "signed-in users",
      service_role: "your backend (bypasses RLS)",
    },
  },
  plain: {
    toggle: "Technical details",
    toggleHint: "Shows RLS, roles and each rule’s SQL",
    state: {
      ok: "Protected",
      warn: "Locked",
      danger: "Unprotected",
      none: "Not in the API",
      view: "View",
    },
    stateHint: {
      ok: "Only those the rules allow get in.",
      warn: "Protection is on but has no rules: nobody gets in through the API.",
      danger: "Anyone with the API address can read and change every row.",
      none: "The API has no permission on this table: only your backend gets in.",
      view: "A saved query (view): it follows the rules of the tables it reads.",
    },
    who: { anon: "Visitors", authenticated: "Signed-in users" },
    access: {
      none: "No access",
      read: "Read only",
      full: "Read and write",
      partial: "Can {verbs}",
    },
    verbs: { read: "see", create: "create", edit: "edit", delete: "delete" },
    rule: {
      everyoneReads: "Anyone can see the rows",
      signedInReads: "Signed-in users can see the rows",
      owner: {
        select: "Each user only sees their own rows",
        insert: "Each user only creates rows in their own name",
        update: "Each user only edits their own rows",
        delete: "Each user only deletes their own rows",
        all: "Each user only sees and changes their own rows",
      },
      ownerColumn: "owner in column {column}",
      custom: "Custom rule",
    },
  },
  sqlPreview: {
    title: "SQL to be executed",
    updating: "· updating…",
    copy: "Copy SQL",
    copied: "SQL copied",
    placeholder: "Fill in the form to see the SQL.",
  },
};

export default en;
