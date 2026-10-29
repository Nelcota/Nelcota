<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { api } from "$lib/transport/api";
  import { copyText } from "$lib/browser/clipboard";
  import { errorMessage, t } from "$lib/i18n/index.svelte";
  import type { DeployToken, DeployTokens } from "$lib/contracts/types";
  let name = $state("ci-deploy");
  let issued = $state<DeployToken | null>(null);
  let tokens = $state<DeployTokens["tokens"]>([]);
  let busy = $state(false);
  let error = $state("");
  async function load() {
    try {
      tokens = (await api.get<DeployTokens>("/tokens/deploy")).tokens;
    } catch (cause) {
      error = errorMessage(cause);
    }
  }
  onMount(() => {
    void load();
  });
  async function issue() {
    if (busy || Boolean(name.trim()) === false) return;
    busy = true;
    error = "";
    try {
      issued = await api.post<DeployToken>("/tokens/deploy", { name, days: 30 });
      await load();
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }
  async function revoke(id: number) {
    busy = true;
    error = "";
    try {
      await api.delete(`/tokens/deploy/${id}`);
      if (issued?.id === id) issued = null;
      await load();
    } catch (cause) {
      error = errorMessage(cause);
    } finally {
      busy = false;
    }
  }
</script>

<section class="grid gap-4 rounded-3xl bg-card p-6">
  <h2 class="text-lg font-semibold">{t("connect.deploy.title")}</h2>
  <p class="text-sm text-muted-foreground">{t("connect.deploy.description")}</p>
  <label class="grid gap-2 text-sm"
    >{t("connect.deploy.name")}<Input bind:value={name} maxlength={100} /></label
  >
  <div>
    <Button disabled={busy || !name.trim()} onclick={issue}>{t("connect.deploy.issue")}</Button>
  </div>
  {#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
  {#if issued}
    <p class="text-sm">{t("connect.deploy.copyOnce", { date: issued.expires_at })}</p>
    <div>
      <Button variant="outline" onclick={() => copyText(issued!.token)}
        >{t("connect.deploy.copy")}</Button
      >
    </div>
  {/if}
  <ul class="grid gap-2">
    {#each tokens as token (token.id)}
      <li class="flex items-center justify-between gap-3 text-sm">
        <span>{token.name} · {token.expires_at}</span>
        {#if !token.revoked_at}<Button
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={() => revoke(token.id)}>{t("connect.deploy.revoke")}</Button
          >{/if}
        {#if token.revoked_at}<span class="text-muted-foreground"
            >{t("connect.deploy.revoked")}</span
          >{/if}
      </li>
    {/each}
  </ul>
</section>
