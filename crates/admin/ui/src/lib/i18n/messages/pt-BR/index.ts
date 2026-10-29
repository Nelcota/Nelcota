import access from "./access";
import data from "./data";
import operations from "./operations";
import workspace from "./workspace";
// The Portuguese catalog, the shape every other language follows. Loaded on
// demand (see ../../index.svelte.ts), so only the active language is downloaded.

export default {
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
