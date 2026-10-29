// API page: endpoints, roles, service_role token and code examples.
import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/operations/connect";

const en: Messages<typeof ptBR> = {
  title: "Connect",
  navigation: "API documentation sections",
  short: {
    address: "Address",
    caller: "Who calls",
    sdk: "SDK",
    ai: "AI",
    examples: "Examples",
    token: "Token",
  },
  description: "How your app talks to this project.",
  start: "Connect my app",
  openapi: "OpenAPI documentation",
  address: "Project address",
  copyAddress: "Copy address",
  endpoints: {
    rest: "tables, views and functions (rpc) of the exposed schema",
    auth: "sign-up, login, session and current user",
    jwks: "public key to validate the JWTs",
  },
  caller: "Who makes the call",
  callerHint:
    "There is no anon key: whoever sends no token is already anon. Each role’s access is defined per table, in the table permissions (GRANTs, on the Structure tab) and in the policies.",
  roles: {
    anon: {
      title: "Visitor",
      text: "Request without an Authorization header. Sees what the table permissions (GRANTs) and policies allow for the anon role.",
    },
    authenticated: {
      title: "Signed-in user",
      text: "Authorization: Bearer with the access_token from login. auth.uid() is their id in policies.",
    },
    service_role: {
      title: "Your backend",
      text: "Bearer with the service_role token. Bypasses RLS (but still needs permission on the table, a GRANT): only in code that runs on the server.",
    },
  },
  neverInBrowser: "Never use it in the browser.",
  examples: "Examples",
  topic: "Topic",
  topics: {
    tables: "Tables",
    auth: "Authentication",
  },
  table: "Table",
  language: "Language",
  noTables: "Create a table to see examples with its columns.",
  types: "TypeScript types for the tables:",
  downloadTypes: "Download database.ts",
  sdkLabel: "TypeScript (SDK)",
  sdk: {
    title: "Connect with the SDK",
    text: "The official TypeScript client: typed from your tables, refreshes the session by itself and runs in browsers, Node, Deno and Bun.",
    install: "Install it",
    client: "Create the client",
    types: "Generate your tables’ types and save them next to the client",
    orCli: "or from the terminal:",
    docs: "SDK documentation",
  },
  deploy: {
    title: "Deployment tokens",
    description:
      "Use these credentials for migrations and type downloads from the CLI or CI. They permit administrator SQL through migrations. Keep them in server secrets. Tokens expire after 30 days and can be revoked here.",
    name: "Token name",
    issue: "Create deployment token",
    copy: "Copy deployment token",
    copyOnce: "Copy this token now; it is only shown once. Expires: {date}",
    revoke: "Revoke",
    revoked: "Revoked",
  },
  ai: {
    migrationVersion: "Context migration: {version}",
    noMigration: "none applied",
    emptySchema: "No tables are exposed yet. Apply migrations and regenerate the context.",
    outdated:
      "This context is outdated: applied migrations have changed. Regenerate it before copying or downloading.",
    changedDuringGeneration: "Migrations changed while generating the context. Regenerate it.",
    freshnessFailed:
      "Could not verify the current migration version. Refresh the context before using it.",
    title: "Context for AI",
    text: "An llms.txt-style text to paste into ChatGPT, Claude, Cursor or another assistant: this project’s address, the schema as types, the access rules (RLS), the buckets and how to use the SDK. The assistant then writes code that works here instead of inventing tables.",
    safe: "Contains no keys, passwords or tokens. Generate it again after changing the schema.",
    copy: "Copy context",
    copied: "Context copied. Paste it into the conversation.",
    download: "Download llms.txt",
    building: "Building…",
    failed: "Could not build the context: {message}",
    preview: "Show the text ({size})",
  },
  snippets: {
    list: {
      label: "List rows",
      description:
        "The first 20 (order=column.desc sorts). Without a token, you get what the anon role can see.",
      sdk: "The first 20. Without signing in, you get what a visitor can see.",
    },
    filter: {
      label: "Filter",
      description:
        "Operators: eq, neq, gt, gte, lt, lte, ilike, in, is (e.g. {column}=ilike.*abc*).",
      sdk: "Filters: eq, neq, gt, gte, lt, lte, like, ilike, in, is and or(...). The value is checked against the type of {column}.",
    },
    insert: {
      label: "Insert",
      description:
        "Missing columns get their DEFAULT. Prefer: return=representation returns the created row.",
      sdk: "Missing columns get their DEFAULT. .select() returns the created row.",
    },
    update: {
      label: "Update",
      description:
        "PATCH requires a filter: without one the API refuses, so the whole table is not changed.",
      sdk: "Requires a filter: without one the API refuses, so the whole table is not changed.",
    },
    delete: {
      label: "Delete",
      description: "DELETE also requires a filter.",
      sdk: "Also requires a filter.",
    },
    signup: {
      label: "Sign up",
      description: "Returns the session (access_token and refresh_token), already signed in.",
      sdk: "session is null while the email awaits confirmation.",
    },
    login: {
      label: "Sign in",
      description:
        "The access_token goes in the Authorization header of API calls (authenticated role).",
      sdk: "From then on, every call carries the user’s token (authenticated role).",
    },
    refresh: {
      label: "Refresh the session",
      description: "The access_token expires in minutes; trade the refresh_token for a new pair.",
      sdk: "The SDK refreshes the session before it expires, in every tab. onChange tells you when it changes.",
    },
  },
  code: {
    label: "Code",
  },
  token: {
    title: "Token",
    intro:
      "For your backend to call the API as service_role, without going through the access rules.",
    warningTitle: "It bypasses all RLS",
    warning: "Keep it like a password: never in a frontend, a mobile app or a repository.",
    details:
      "The token is not stored on the server: it lasts until it expires, and generating another does not revoke earlier ones. It still depends on a GRANT on each table (tables created by the panel already give service_role full access).",
    copy: "Copy token",
    reveal: "Show token",
    hidden: "Token hidden",
    confirmTitle: "Generate a service_role token?",
    confirmDescription:
      "It lasts {validity}, bypasses row protection (RLS) on every table and cannot be revoked: it only stops working when it expires. Generate it only for your server code.",
    copyNow: "Copy it now: it will not be shown again. Valid until {date}.",
    validity: "Validity",
    days: { one: "{count} day", other: "{count} days" },
    oneYear: "1 year",
    generating: "Generating…",
    generateAnother: "Generate another",
    generate: "Generate token",
    orOnServer: "or on the server:",
  },
};

export default en;
