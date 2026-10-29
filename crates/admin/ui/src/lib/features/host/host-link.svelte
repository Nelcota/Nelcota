<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$lib/transport/api";
  import { t } from "$lib/i18n/index.svelte";
  import { controllerOrigin } from "../updates/controller";
  let origin = $state<string | null>(null);
  let alive = true;
  onMount(() => {
    const abort = new AbortController();
    void api
      .get<{ controller_origin: unknown }>("/updates", { signal: abort.signal })
      .then((value) => {
        if (alive) origin = controllerOrigin(value.controller_origin);
      })
      .catch(() => {});
    return () => {
      alive = false;
      abort.abort();
    };
  });
</script>

{#if origin}<div class="grid gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4">
    <p class="text-sm">{t("updates.authority")}</p>
    <a
      class="w-fit rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      href={`${origin}/admin/`}
      target="_blank"
      rel="noopener noreferrer"
      >{t("host.title")}<span class="sr-only"> {t("common.newTab")}</span></a
    >
  </div>{/if}
