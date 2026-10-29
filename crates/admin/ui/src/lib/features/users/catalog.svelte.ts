import type { UsersResponse } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api, enc } from "$lib/transport/api";
export type { User } from "$lib/contracts/types";

/** Owns user inventory publication and explicit account administration requests. */
export class UserCatalog extends RemoteResource<UsersResponse> {
  reload(params: URLSearchParams): Promise<boolean> {
    return this.load((signal) => api.get<UsersResponse>(`/users?${params}`, { signal }));
  }
  confirmEmail(id: string): Promise<unknown> {
    return api.post(`/users/${enc(id)}/confirm`);
  }
  revoke(id: string): Promise<unknown> {
    return api.post(`/users/${enc(id)}/revoke`);
  }
  remove(id: string): Promise<unknown> {
    return api.delete(`/users/${enc(id)}`);
  }
}
