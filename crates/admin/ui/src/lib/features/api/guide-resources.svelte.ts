import type {
  MigrationsData,
  PoliciesData,
  ProjectsData,
  StorageOverview,
  TableData,
  TablesResponse,
} from "$lib/contracts/types";
import { t } from "$lib/i18n/index.svelte";
import { href } from "$lib/navigation/router.svelte";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api, enc, expireSession, httpError } from "$lib/transport/api";

import { tableSnippets, type Snippet } from "./api-examples.js";
import { latestMigration, llmContext } from "./llm-context.js";
type ContextSnapshot = { text: string; version: number | null; empty: boolean };

/** Publishes examples and context only after matching the generated schema's migration version. */
export class ApiGuideResources {
  readonly tables = new RemoteResource<TablesResponse>();
  readonly snippets = new RemoteResource<Snippet[]>();
  readonly context = new RemoteResource<ContextSnapshot>();
  readonly migrations = new RemoteResource<MigrationsData>();
  constructor(private readonly origin: string) {}
  loadTables(): Promise<boolean> {
    return this.tables.load((signal) => api.get<TablesResponse>("/tables", { signal }));
  }
  loadMigrations(): Promise<boolean> {
    return this.migrations.load((signal) => api.get<MigrationsData>("/migrations", { signal }));
  }
  loadContext(): Promise<boolean> {
    return this.context.load((signal) => this.contextSnapshot(signal));
  }
  loadSnippets(table: string): Promise<boolean> {
    return this.snippets.load(async (signal) => {
      const data = await api.get<TableData>(`/tables/${enc(table)}?size=1`, { signal });
      return tableSnippets(this.origin, table, {
        columns: data.table.columns.map((column) => ({
          name: column.name,
          type: column.full_type,
          has_default: column.has_default,
          generated: column.generated,
          nullable: column.nullable,
          enum_values: column.enum_values,
        })),
        primaryKey: data.table.primary_key,
        insertable: data.table.insertable,
      });
    });
  }
  private async contextSnapshot(signal: AbortSignal): Promise<ContextSnapshot> {
    const before = latestMigration(await api.get<MigrationsData>("/migrations", { signal }));
    const types = this.generatedTypes(signal);
    const [projects, policies, storage, snapshot] = await Promise.all([
      api.get<ProjectsData>("/projects", { signal }),
      api.get<PoliciesData>("/policies", { signal }),
      api.get<StorageOverview>("/storage", { signal }),
      types,
    ]);
    const after = await api.get<MigrationsData>("/migrations", { signal });
    if (before !== latestMigration(after) || before !== snapshot.version)
      throw new Error(t("connect.ai.changedDuringGeneration"));
    this.migrations.data = after;
    return {
      text: llmContext({
        origin: this.origin,
        project: projects.current,
        generatedAt: new Date(),
        migrationVersion: before,
        types: snapshot.code,
        policies,
        storage,
      }),
      version: before,
      empty: policies.tables.length === 0,
    };
  }
  private async generatedTypes(signal: AbortSignal) {
    const response = await fetch(href("/api/typescript"), {
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.ok === false) {
      expireSession(response.status, "/typescript");
      throw httpError(response.status);
    }
    const version = response.headers.get("x-nelcota-migration-version");
    if (version === null) throw new Error(t("connect.ai.freshnessFailed"));
    return { code: await response.text(), version: version === "none" ? null : Number(version) };
  }
}
