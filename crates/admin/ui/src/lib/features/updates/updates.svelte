<script lang="ts">
  import { ArrowUpRight, CircleArrowUp as ArrowUpCircle } from "@lucide/svelte";

  import { EmptyState, PageHeader, LoadError } from "$lib/components/shared";
  import { href } from "$lib/navigation/router.svelte";
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { api } from "$lib/transport/api";
  import { RemoteResource } from "$lib/resources/remote-resource.svelte";

  import { t, errorMessage } from "$lib/i18n/index.svelte";
  import { controllerOrigin } from "./controller";
  const resource = new RemoteResource<{ version: string; controller_origin: unknown }>();
  const origin = $derived(controllerOrigin(resource.data?.controller_origin));
  const version = $derived(
    typeof resource.data?.version === "string" && resource.data.version !== ""
      ? resource.data.version
      : "…",
  );
  async function load() {
    await resource.load((signal) => api.get("/updates", { signal }));
  }
  onMount(() => {
    void load();
    return () => resource.cancel();
  });
</script>

<div class="mx-auto w-full max-w-page px-4 pt-2 pb-12 sm:px-6 lg:px-8" aria-busy={resource.loading}>
  <PageHeader title={t("updates.title")} description={t("updates.subtitle")} />
  {#if resource.error}<LoadError
      message={errorMessage(resource.error)}
      onretry={load}
      busy={resource.loading}
    />{/if}
  {#if !resource.loaded || resource.loading}
    <p role="status" class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {/if}
  {#if resource.loaded && !resource.loading && !resource.error}
    {#if origin}
      <div class="grid gap-4 rounded-3xl bg-card p-5 sm:p-6">
        <p class="text-base">{t("updates.current")}: <strong translate="no">{version}</strong></p>
        <p class="text-sm text-muted-foreground">{t("updates.authority")}</p>
        <Button class="w-fit" href={`${origin}/admin/`} target="_blank" rel="noopener noreferrer"
          >{t("updates.open")}<span class="sr-only"> {t("common.newTab")}</span><ArrowUpRight
            data-icon="inline-end"
            aria-hidden="true"
          /></Button
        >
      </div>
    {/if}
    {#if origin === null}
      <EmptyState
        class="rounded-3xl bg-card"
        icon={ArrowUpCircle}
        title={t("updates.unenrolled")}
        description={t("updates.unenrolledHint")}
      >
        {#snippet actions()}<Button variant="outline" href={href("/guides/deploy")}
            >{t("updates.guide")}<ArrowUpRight data-icon="inline-end" aria-hidden="true" /></Button
          >{/snippet}
      </EmptyState>
      <p role="status" class="mt-4 text-sm text-muted-foreground">
        {t("updates.current")}: <strong translate="no">{version}</strong>
      </p>
    {/if}
  {/if}
</div>
