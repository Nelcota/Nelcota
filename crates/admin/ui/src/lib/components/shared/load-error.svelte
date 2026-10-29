<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import { t } from "$lib/i18n/index.svelte";

  // A page or block that could not load: what happened in plain words and a
  // way to try again, on the same card surface as the content it replaces.
  let {
    message,
    onretry,
    busy = false,
  }: { message: string; onretry: () => void | Promise<void>; busy?: boolean } = $props();
</script>

<div class="flex flex-wrap items-center gap-4 rounded-3xl bg-card p-5" role="alert">
  <span
    class="grid size-10 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive"
  >
    <CircleAlert class="size-5" aria-hidden="true" />
  </span>
  <div class="grid min-w-0 flex-1 basis-48 gap-0.5">
    <p class="text-sm font-semibold">{t("common.loadFailed")}</p>
    <p class="text-sm break-words text-muted-foreground">{message}</p>
  </div>
  <Button variant="outline" disabled={busy} onclick={onretry}>
    <RefreshCw data-icon="inline-start" class={busy ? "animate-spin" : ""} aria-hidden="true" />{t(
      "common.retry",
    )}
  </Button>
</div>
