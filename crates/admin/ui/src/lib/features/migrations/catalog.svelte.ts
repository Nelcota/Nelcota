import type { MigrationsData, ExportedMigration, MigrationApplication } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api } from "$lib/transport/api";
export type { ExportedMigration, MigrationsData } from "$lib/contracts/types";

/** Owns migration inventory publication and explicit generation requests. */
export class MigrationCatalog extends RemoteResource<MigrationsData> {
  reload(): Promise<boolean> {
    return this.load((signal) => api.get<MigrationsData>("/migrations", { signal }));
  }
  apply(
    files: readonly { filename: string; sql: string }[],
    dryRun: boolean,
    signal?: AbortSignal,
  ): Promise<MigrationApplication> {
    return api.post<MigrationApplication>(
      "/migrations/apply",
      { files, dry_run: dryRun },
      signal === undefined ? {} : { signal },
    );
  }
  generate(name: string): Promise<ExportedMigration> {
    return api.post<ExportedMigration>("/migrations", { name });
  }
}
