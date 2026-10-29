// Column types the server accepts (base list + the schema's enums). Loaded
// once per session (new enums show up after reloading the page).

import { querySession } from "$lib/resources/query-client";
import { api } from "$lib/transport/api";

import { ddl } from "./ddl";

const catalog = $state({ base: [] as string[], enums: [] as string[], loaded: false, epoch: -1 });
export const pgTypes = {
  get base() {
    return catalog.epoch === querySession() ? catalog.base : [];
  },
  get enums() {
    return catalog.epoch === querySession() ? catalog.enums : [];
  },
  get loaded() {
    return catalog.epoch === querySession() && catalog.loaded;
  },
};

let pending: { epoch: number; promise: Promise<void> } | undefined;

export function loadTypes(): Promise<void> {
  const epoch = querySession();
  if (pending?.epoch === epoch) return pending.promise;
  const promise = ddl
    .types()
    .then((types) => {
      if (epoch !== querySession() || pending?.promise !== promise) return;
      catalog.base = types.base;
      catalog.enums = types.enums;
      catalog.epoch = epoch;
      catalog.loaded = true;
    })
    .catch(() => {
      // Without the list the field still accepts free text (the server validates).
      if (pending?.promise === promise) pending = undefined;
    });
  pending = { epoch, promise };
  return promise;
}

/** Tables and columns of the exposed schema, to pick a foreign key. */
export async function loadSchemaColumns(): Promise<Record<string, string[]>> {
  const { tables } = await api.get<{ tables: Record<string, string[]> }>("/schema");
  // `auth.users` and the like stay out: the FK is for the exposed schema only.
  return Object.fromEntries(
    Object.entries(tables).filter(([name]) => name.includes(".") === false),
  );
}
