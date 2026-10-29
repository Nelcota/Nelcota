import type { SignIn } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api } from "$lib/transport/api";

/** Reads sign-in configuration while retaining the latest request's ownership. */
export class SignInSettings extends RemoteResource<SignIn> {
  reload(): Promise<boolean> {
    return this.load((signal) => api.get<SignIn>("/sign-in", { signal }));
  }
}
