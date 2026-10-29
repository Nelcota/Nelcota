// The English catalog, typed against the Portuguese one: a missing or extra
// key is a type error. Loaded on demand (see ../../index.svelte.ts).
import type { Messages } from "../../index.svelte";
import type ptBR from "../pt-BR";
import access from "./access";
import data from "./data";
import operations from "./operations";
import workspace from "./workspace";

const en: Messages<typeof ptBR> = {
  common: workspace.common,
  shell: workspace.shell,
  login: access.login,
  overview: workspace.overview,
  users: access.users,
  storage: data.storage,
  projects: workspace.projects,
  profile: access.profile,
  policies: access.policies,
  connect: operations.connect,
  signIn: access.signIn,
  migrations: data.migrations,
  tables: data.tables,
  sql: data.sql,
  palette: workspace.palette,
  errors: workspace.errors,
  guided: workspace.guided,
  guides: workspace.guides,
  webhooks: data.webhooks,
  updates: operations.updates,
  host: operations.host,
  server: operations.server,
  alerts: operations.alerts,
};

export default en;
