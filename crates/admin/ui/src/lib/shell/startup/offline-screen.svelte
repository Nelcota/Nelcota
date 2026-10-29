<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import EntryLayout from "../components/entry-layout.svelte";
  import { errorMessage, t } from "$lib/i18n/index.svelte";

  // The server could not be reached while checking the session.
  let { error, checking, onretry }: { error: unknown; checking: boolean; onretry: () => void } =
    $props();
</script>

<EntryLayout>
  <main class="flex flex-1 items-center justify-center pt-6 pb-10">
    <!-- On a card like the login and the 404. -->
    <div
      class="flex w-full max-w-md flex-col items-center gap-6 rounded-3xl bg-card px-8 pt-8 pb-10 text-center"
      role="alert"
    >
      <div class="grid gap-2">
        <h1 class="text-xl font-semibold tracking-tight">{t("shell.app.offlineTitle")}</h1>
        <p class="text-sm text-muted-foreground">{errorMessage(error)}</p>
      </div>
      <Button disabled={checking} onclick={onretry}>
        {#if checking}<LoaderCircle
            data-icon="inline-start"
            class="animate-spin"
            aria-hidden="true"
          />{/if}{t("common.retry")}
      </Button>
    </div>
  </main>
</EntryLayout>
