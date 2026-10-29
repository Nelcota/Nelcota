<script lang="ts">
  import { Check, ArrowUpRight } from "@lucide/svelte";
  import { Button } from "$lib/components/ui";
  import type { Overview } from "$lib/contracts/types";
  import { href } from "$lib/navigation/router.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { nextSteps } from "../model";
  let { data }: { data: Overview } = $props();
  const steps = $derived(nextSteps(data));
  const done = $derived(steps.filter((step) => step.done).length);
  const firstTable = $derived(data.tables.find((table) => table.kind === "table"));
  const reviews = [
    { id: "migrate", path: "/migrations", action: "openMigrations" },
    { id: "publish", path: "/connect?section=api-deploy", action: "openDeployment" },
    { id: "recover", path: "/guides/backup?section=restore", action: "openRecovery" },
  ] as const;
</script>

<details class="grid rounded-3xl bg-card p-5" open={done < steps.length}>
  <summary class="cursor-pointer text-lg font-semibold"
    >{t("overview.journey.title")}
    <span class="ml-2 text-sm font-normal text-muted-foreground"
      >{t("overview.journey.setup", { done, total: steps.length })}</span
    >
  </summary>
  <ol class="mt-4 grid gap-3 sm:grid-cols-2">
    {#each steps as step (step.id)}
      <li class="grid gap-2 rounded-2xl border p-4">
        <a href={href(step.path)} class="flex items-center gap-2 font-medium hover:underline">
          {#if step.done}<Check
              class="size-4 text-brand"
              aria-label={t("overview.steps.done")}
            />{/if}
          {t(`overview.steps.${step.id}.label`)}<ArrowUpRight
            class="ml-auto size-4 shrink-0"
            aria-hidden="true"
          />
        </a>
        <p class="text-sm text-muted-foreground">{t(`overview.steps.${step.id}.hint`)}</p>
      </li>
    {/each}
  </ol>
  <div class="mt-4 grid gap-2 rounded-2xl bg-well p-4">
    <h3 class="font-medium">{t("overview.journey.verify")}</h3>
    <p class="text-sm text-muted-foreground">{t("overview.journey.verifyHint")}</p>
    <p class="text-sm text-muted-foreground">{t("overview.journey.accessHint")}</p>
    {#if firstTable}<Button
        class="w-fit"
        variant="outline"
        href={href(`/tables/${encodeURIComponent(firstTable.name)}?_preview=anon`)}
        >{t("overview.journey.access")}</Button
      >{/if}
  </div>
  <h3 class="mt-5 font-semibold">{t("overview.journey.continue")}</h3>
  <ol class="mt-3 grid gap-3 lg:grid-cols-3">
    {#each reviews as review (review.id)}
      <li class="flex flex-col gap-3 rounded-2xl border p-4">
        <p class="text-xs text-muted-foreground">{t("overview.journey.review")}</p>
        <h4 class="font-medium">{t(`overview.journey.${review.id}`)}</h4>
        <p class="flex-1 text-sm text-muted-foreground">{t(`overview.journey.${review.id}Hint`)}</p>
        <Button variant="outline" href={href(review.path)}
          >{t(`overview.journey.${review.action}`)}</Button
        >
      </li>
    {/each}
  </ol>
</details>
