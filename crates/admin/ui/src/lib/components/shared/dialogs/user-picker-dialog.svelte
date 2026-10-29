<script lang="ts">
  import * as Command from "$lib/components/ui/command";
  import { RemoteResource } from "$lib/resources/remote-resource.svelte";
  import { api } from "$lib/transport/api";
  import { errorMessage } from "$lib/i18n/index.svelte";
  import type { UsersResponse } from "$lib/contracts/types";
  import type { RunAsLabels, RunAsUser } from "$lib/shared/run-as";
  const SEARCH_DEBOUNCE_IN_MS = 200;

  let {
    open = $bindable(false),
    labels,
    onpick,
  }: { open?: boolean; labels: RunAsLabels; onpick: (user: RunAsUser) => void } = $props();

  // The 50 most recent users, or those matching the search on the server.
  const resource = new RemoteResource<UsersResponse>();
  let search = $state("");
  let debounce: ReturnType<typeof setTimeout>;

  function load(query: string) {
    const params = new URLSearchParams({ page: "0" });
    if (query !== "") params.set("q", query);
    void resource.load((signal) => api.get<UsersResponse>(`/users?${params}`, { signal }));
  }

  $effect(() => {
    if (open === false) return;
    const query = search.trim();
    clearTimeout(debounce);
    debounce = setTimeout(() => load(query), query !== "" ? SEARCH_DEBOUNCE_IN_MS : 0);
    return () => clearTimeout(debounce);
  });

  function pick(user: RunAsUser) {
    onpick(user);
    open = false;
    search = "";
  }
</script>

<Command.Dialog bind:open title={labels.pickTitle} description={labels.authenticatedHint}>
  <Command.Input bind:value={search} aria-label={labels.search} placeholder={labels.search} />
  <Command.List aria-label={labels.pickTitle} class="max-h-[min(60vh,360px)]">
    {#if resource.error}
      <p role="alert" class="px-4 py-6 text-sm text-destructive">{errorMessage(resource.error)}</p>
    {/if}
    {#if !resource.error && resource.data && resource.data.users.length === 0}
      <p role="status" class="px-4 py-6 text-sm text-muted-foreground">
        {search.trim() ? labels.empty : labels.noUsers}
      </p>
    {/if}
    {#if !resource.error && !(resource.data && resource.data.users.length === 0) && resource.data}
      <Command.Group heading={labels.pickTitle}>
        {#each resource.data.users as user (user.id)}
          <Command.Item
            value={`${user.email} ${user.id}`}
            onSelect={() => pick({ id: user.id, email: user.email })}
          >
            <span class="truncate">{user.email}</span>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
    {#if !resource.error && !(resource.data && resource.data.users.length === 0) && !resource.data}
      <p role="status" class="px-4 py-6 text-sm text-muted-foreground">{labels.loading}</p>
    {/if}
  </Command.List>
</Command.Dialog>
