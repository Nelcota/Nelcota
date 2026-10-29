import type { PoliciesData } from "$lib/contracts/types";

export type PolicyTable = PoliciesData["tables"][number];
export type PolicyFilter = "all" | "enabled" | "disabled" | "attention";
const POLICY_FILTERS: readonly PolicyFilter[] = ["all", "enabled", "disabled", "attention"];

// Rótulo que o servidor usa para views que rodam com os privilégios do dono.
export const OWNER_VIEW_LABEL = "view owner privileges";

/** O que precisa de atenção, com a correção que a página oferece para cada caso. */
export type AttentionItem =
  | { readonly kind: "unprotected"; readonly table: string }
  | { readonly kind: "ownerView"; readonly table: string }
  | { readonly kind: "noRules"; readonly table: string }
  | { readonly kind: "relation"; readonly table: string };

const URGENCY: Record<string, number> = { danger: 0, warn: 1 };
const CALM = 2;

function needsAttention(table: PolicyTable): boolean {
  return table.rls.state === "danger" || table.rls.state === "warn";
}

export function isOwnerView(table: PolicyTable): boolean {
  return table.rls.label === OWNER_VIEW_LABEL;
}

export function inFilter(table: PolicyTable, filter: PolicyFilter): boolean {
  if (filter === "all") return true;
  if (filter === "enabled") return table.rls.enabled;
  if (filter === "disabled") return table.rls.enabled === false && table.rls.state !== "view";
  return needsAttention(table);
}

export function parseFilter(value: string | null): PolicyFilter {
  return POLICY_FILTERS.find((filter) => filter === value) ?? "all";
}

/** Tabelas abertas primeiro, depois as bloqueadas sem regra, depois o resto; cada grupo em ordem alfabética. */
export function byUrgency(tables: readonly PolicyTable[]): PolicyTable[] {
  return [...tables].toSorted((first, second) => {
    const difference = (URGENCY[first.rls.state] ?? CALM) - (URGENCY[second.rls.state] ?? CALM);
    if (difference !== 0) return difference;
    return first.name.localeCompare(second.name);
  });
}

/** Objetos expostos sem RLS que não aparecem na lista de tabelas (views, views materializadas, tabelas externas). */
export function exposedRelations(data: PoliciesData): string[] {
  return data.exposed_without_rls.filter(
    (name) => data.tables.some((table) => table.name === name) === false,
  );
}

export function attentionItems(data: PoliciesData): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const table of byUrgency(data.tables)) {
    if (table.rls.state === "danger")
      items.push({ kind: isOwnerView(table) ? "ownerView" : "unprotected", table: table.name });
    if (table.rls.state === "warn") items.push({ kind: "noRules", table: table.name });
  }
  for (const name of exposedRelations(data)) items.push({ kind: "relation", table: name });
  return items;
}

export type PolicyStats = {
  readonly tables: number;
  readonly protected: number;
  readonly rules: number;
};

/** Views ficam de fora: seguem as regras das tabelas que leem. */
export function policyStats(tables: readonly PolicyTable[]): PolicyStats {
  const real = tables.filter((table) => table.rls.state !== "view");
  return {
    tables: real.length,
    protected: real.filter((table) => table.rls.enabled).length,
    rules: real.reduce((sum, table) => sum + table.policies.length, 0),
  };
}
