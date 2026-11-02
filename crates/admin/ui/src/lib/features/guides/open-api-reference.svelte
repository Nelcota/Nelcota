<script lang="ts">
  import { onMount } from "svelte";
  import { RefreshCw, Download, Rows3 } from "@lucide/svelte";

  import EmptyState from "$lib/components/shared/empty-state.svelte";
  import { Button, Badge, Skeleton } from "$lib/components/ui";

  import LoadError from "$lib/components/shared/load-error.svelte";
  import { RemoteResource } from "$lib/resources/remote-resource.svelte";
  import { downloadText } from "$lib/browser/download";
  import { errorMessage, i18n, t } from "$lib/i18n/index.svelte";
  import { isOpenApiDocument, operations, type OpenApiDocument } from "./openapi";
  import { translateOpenApi } from "./openapi-prose";

  const resource = new RemoteResource<OpenApiDocument>();
  let frame = $state<HTMLIFrameElement>();
  // The theme last sent: other class changes on <html> must not make the
  // reference clone, translate and re-render the whole document again.
  let sentDark: boolean | undefined;
  const isDark = () => document.documentElement.classList.contains("dark");
  function sendDocument() {
    if (resource.data === null) return;
    // Clone the raw resource value so schema/property keys such as __proto__ survive.
    const source = structuredClone(resource.data);
    sentDark = isDark();
    frame?.contentWindow?.postMessage(
      {
        type: "nelcota:openapi",
        document: translateOpenApi(source, i18n.locale),
        dark: sentDark,
        locale: i18n.locale,
      },
      location.origin,
    );
  }
  function themeChanged() {
    if (isDark() !== sentDark) sendDocument();
  }
  $effect(() => {
    if (resource.data != null) sendDocument();
  });

  async function load() {
    await resource.load(async (signal) => {
      const response = await fetch("/rest/v1/", {
        signal,
        headers: { Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
      });
      if (response.ok === false) throw new Error(t("guides.openapi.unavailable"));
      const data: unknown = await response.json();
      if (isOpenApiDocument(data) === false) throw new Error(t("guides.openapi.invalid"));
      return data;
    });
  }
  onMount(() => {
    void load();
    const observer = new MutationObserver(themeChanged);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      resource.cancel();
    };
  });
</script>

<div class="grid min-w-0 gap-5">
  <p class="rounded-2xl bg-well p-4 text-sm leading-relaxed text-muted-foreground">
    {t("guides.openapi.hint")}
  </p>
  <div class="flex flex-wrap items-center gap-2">
    <Button variant="outline" size="sm" onclick={load} disabled={resource.loading}
      ><RefreshCw />{t("guides.openapi.reload")}</Button
    >
    {#if resource.data}<Button
        variant="outline"
        size="sm"
        onclick={() =>
          downloadText("openapi.json", JSON.stringify(resource.data, null, 2), "application/json")}
        ><Download />{t("guides.openapi.download")}</Button
      ><Badge variant="secondary">OpenAPI {resource.data.openapi}</Badge>{/if}
  </div>
  {#if resource.error}<LoadError
      message={errorMessage(resource.error)}
      onretry={load}
      busy={resource.loading}
    />{/if}
  {#if resource.loading}<Skeleton class="h-48 rounded-2xl" />
  {/if}
  {#if !resource.loading && resource.data}
    {#if operations(resource.data).length}
      <iframe
        bind:this={frame}
        src="/admin/assets/reference.html"
        title={t("guides.entries.openapi.title")}
        onload={sendDocument}
        class="h-[75dvh] min-h-96 w-full rounded-xl border"
      ></iframe>
    {/if}
    {#if !operations(resource.data).length}
      <EmptyState
        icon={Rows3}
        title={t("guides.openapi.empty")}
        description={t("guides.openapi.emptyHint")}
      />
    {/if}
  {/if}
</div>
