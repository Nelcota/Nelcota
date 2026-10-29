// Table and policy structure: types mirroring the panel API, the client and
// the pure rules (difference between columns, fields of each policy).

import type {
  ApiRole,
  Privilege,
  OnDelete,
  ReferenceDef,
  ColumnDef,
  GrantDef,
  CreateTable,
  AlterAction,
  ColumnInfo,
  Structure,
  PolicyRole,
  PolicyDef,
  DdlResult,
} from "$lib/contracts/types";
import type { Command as PolicyCommand } from "$lib/contracts/types";
import type { MessageKey } from "$lib/i18n/index.svelte";
import { api, enc } from "$lib/transport/api";
export type {
  ApiRole,
  Privilege,
  OnDelete,
  ColumnDef,
  GrantDef,
  CreateTable,
  AlterAction,
  ColumnInfo,
  Structure,
  PolicyDef,
  DdlResult,
  PolicyCommand,
};
import { t } from "$lib/i18n/index.svelte";
import { toast } from "svelte-sonner";

async function change(pending: Promise<DdlResult>): Promise<DdlResult> {
  const result = await pending;
  if (result.catalog_pending) toast.warning(t("common.catalogPending"), { duration: 10000 });
  return result;
}

export const API_ROLES: readonly ApiRole[] = ["anon", "authenticated", "service_role"];
export const PRIVILEGES: readonly Privilege[] = ["select", "insert", "update", "delete"];

/** `label` is a translation key: render it with `t(option.label)`. */
export const ON_DELETE: readonly { value: OnDelete; label: MessageKey }[] = [
  { value: "no_action", label: "tables.columns.onDelete.no_action" },
  { value: "cascade", label: "tables.columns.onDelete.cascade" },
  { value: "set_null", label: "tables.columns.onDelete.set_null" },
  { value: "restrict", label: "tables.columns.onDelete.restrict" },
  { value: "set_default", label: "tables.columns.onDelete.set_default" },
];

export const blankColumn = (): ColumnDef => ({
  name: "",
  data_type: "text",
  nullable: true,
  default: null,
  primary_key: false,
  identity: false,
  unique: false,
  references: null,
  comment: null,
});

const blank = (text: string | null | undefined) =>
  text == null || text.trim() === "" ? null : text.trim();

/** `on_delete` as pg_catalog describes it (`set null`) in the API format. */
const onDeleteValue = (text: string): OnDelete => text.replace(" ", "_") as OnDelete;

/** An existing column in the form's format. */
export function toColumnDef(info: ColumnInfo): ColumnDef {
  return {
    name: info.name,
    data_type: info.data_type,
    nullable: info.nullable,
    default: info.default,
    primary_key: info.primary_key,
    identity: info.identity !== null,
    unique: info.unique !== null,
    references:
      info.references != null
        ? {
            table: info.references.table,
            column: info.references.column,
            on_delete: onDeleteValue(info.references.on_delete),
          }
        : null,
    comment: info.comment,
  };
}

const sameReference = (a: ReferenceDef | null, b: ReferenceDef | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.table === b.table &&
    a.column === b.column &&
    a.on_delete === b.on_delete);

/**
 * Actions that take column `original` to the `edited` state. The rename goes
 * last: the earlier actions use the old name (the server also follows renames,
 * but this way the preview reads in natural order).
 */
export function columnChanges(original: ColumnInfo, edited: ColumnDef): AlterAction[] {
  const column = original.name;
  const before = toColumnDef(original);
  const actions: AlterAction[] = [];
  if (edited.data_type.trim() !== before.data_type) {
    actions.push({ action: "set_type", column, data_type: edited.data_type.trim() });
  }
  if (edited.nullable !== before.nullable)
    actions.push({ action: "set_nullable", column, nullable: edited.nullable });
  if (
    blank(edited.default) !== blank(before.default) &&
    original.identity === null &&
    Boolean(original.generated) === false
  ) {
    actions.push({ action: "set_default", column, default: blank(edited.default) });
  }
  if (edited.unique !== before.unique)
    actions.push({ action: "set_unique", column, unique: edited.unique });
  if (sameReference(edited.references, before.references) === false) {
    actions.push({ action: "set_reference", column, reference: edited.references });
  }
  if (blank(edited.comment) !== blank(before.comment)) {
    actions.push({ action: "set_column_comment", column, comment: blank(edited.comment) });
  }
  if (edited.name.trim() !== column)
    actions.push({ action: "rename_column", from: column, to: edited.name.trim() });
  return actions;
}

/** GRANTs that changed, as `set_grants` actions (one per changed role). */
export function grantChanges(before: Structure["grants"], after: GrantDef[]): AlterAction[] {
  return after
    .filter((grant) => {
      const old = before.find((b) => b.role === grant.role)?.privileges ?? [];
      return (
        old.length !== grant.privileges.length ||
        old.some((p) => Boolean(grant.privileges.includes(p)) === false)
      );
    })
    .map((grant) => ({ action: "set_grants", grant }));
}

/** Which expressions each command accepts (same rule as the server). */
export function policyFields(command: PolicyCommand): { using: boolean; check: boolean } {
  return {
    using: command !== "insert",
    check: command !== "select" && command !== "delete",
  };
}

const POLICY_ROLES: ReadonlySet<string> = new Set([
  "public",
  "anon",
  "authenticated",
  "service_role",
]);

/**
 * A policy as GET /policies returns it, in the form's format, or `null` when
 * it names a role the form can't keep (one created in SQL, e.g. `TO editor`):
 * saving it from the form would drop that role and could widen it to PUBLIC.
 */
export function toPolicyDef(policy: {
  name: string;
  command: string;
  roles: string[];
  permissive: boolean;
  using: string | null;
  check: string | null;
}): PolicyDef | null {
  if (policy.roles.every((r) => POLICY_ROLES.has(r)) === false) return null;
  const roles = policy.roles as PolicyRole[];
  return {
    name: policy.name,
    command: policy.command.toLowerCase() as PolicyCommand,
    roles: roles.includes("public") ? [] : roles,
    permissive: policy.permissive,
    using: policy.using,
    check: policy.check,
  };
}

type Options = { signal?: AbortSignal };

type Execution<Settings extends Options = Options> = {
  preview?: boolean | undefined;
  options?: Settings | undefined;
};

export const ddl = {
  types: () => api.get<{ base: string[]; enums: string[] }>("/types"),
  structure: (table: string, options: Options = {}) =>
    api.get<Structure>(`/tables/${enc(table)}/structure`, options),
  createTable: (
    table: CreateTable,
    preview = false,
    options: Options & { policies?: PolicyDef[] } = {},
  ) =>
    change(
      api.post<DdlResult>("/tables", { table, preview, policies: options.policies ?? [] }, options),
    ),
  alterTable: (
    table: string,
    actions: AlterAction[],
    { preview = false, options = {} }: Execution = {},
  ) => change(api.patch<DdlResult>(`/tables/${enc(table)}`, { actions, preview }, options)),
  dropTable: (table: string, cascade: boolean) =>
    change(api.delete<DdlResult>(`/tables/${enc(table)}?cascade=${cascade}`)),
  createPolicy: (
    table: string,
    policy: PolicyDef,
    {
      preview = false,
      options = {},
    }: Execution<Options & { prepareAccess?: boolean; ownerColumn?: string }> = {},
  ) =>
    change(
      api.post<DdlResult>(
        `/tables/${enc(table)}/policies`,
        {
          policy,
          preview,
          prepare_access: options.prepareAccess ?? false,
          owner_column: options.ownerColumn ?? null,
        },
        options,
      ),
    ),
  replacePolicy: (
    table: string,
    original: string,
    {
      policy,
      preview = false,
      options = {},
    }: Execution<Options & { prepareAccess?: boolean }> & { policy: PolicyDef },
  ) =>
    change(
      api.put<DdlResult>(
        `/tables/${enc(table)}/policies/${enc(original)}`,
        { policy, preview, prepare_access: options.prepareAccess ?? false },
        options,
      ),
    ),
  dropPolicy: (table: string, policy: string) =>
    change(api.delete<DdlResult>(`/tables/${enc(table)}/policies/${enc(policy)}`)),
};
