import type { PoliciesData } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { ddl } from "$lib/shared/schema/ddl";
import { api } from "$lib/transport/api";
export type { PolicyDef } from "$lib/shared/schema/ddl";

/** Owns policy inventory publication and explicit schema mutations. */
export class PolicyCatalog extends RemoteResource<PoliciesData> {
  reload(): Promise<boolean> {
    return this.load((signal) => api.get<PoliciesData>("/policies", { signal }));
  }
  enableRls(table: string) {
    return ddl.alterTable(table, [{ action: "set_rls", enabled: true }]);
  }
  dropPolicy(table: string, policy: string) {
    return ddl.dropPolicy(table, policy);
  }
}
