import type { MigrationsData } from "$lib/contracts/types";

export type Migration = MigrationsData["migrations"][number];
export type MigrationStatus = "applied" | "notApplied" | "outsideFolder";

// Só o que pede ação ganha cor (D55): não aplicada aqui ou aplicada sem arquivo na pasta.
export function migrationStatus(migration: Migration): MigrationStatus {
  if (migration.applied_on === null) return "notApplied";
  if (migration.in_folder === false) return "outsideFolder";
  return "applied";
}

export function needsAction(status: MigrationStatus): boolean {
  return status !== "applied";
}

/** A linha do tempo mostra a versão mais nova primeiro, sem mudar a lista recebida. */
export function newestFirst(migrations: readonly Migration[]): Migration[] {
  return [...migrations].toSorted((first, second) => second.version - first.version);
}
