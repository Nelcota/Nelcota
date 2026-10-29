<script lang="ts">
  import { onMount } from "svelte";
  import { ChevronRight, RefreshCw } from "@lucide/svelte";

  import { toast } from "svelte-sonner";
  import { Badge, Button, Skeleton } from "$lib/components/ui";

  import { PageHeader, LoadError, CodeBlock, ConfirmDialog } from "$lib/components/shared";

  import { RemoteResource } from "$lib/resources/remote-resource.svelte";
  import { href, navigate } from "$lib/navigation/router.svelte";
  import { errorMessage, t } from "$lib/i18n/index.svelte";
  import type { WebhookDetail } from "$lib/contracts/types";
  import {
    webhooks,
    canReplay,
    dateLabel,
    durationLabel,
    eventLabel,
    failureLabel,
    statusVariant,
    statusLabel,
  } from "$lib/features/webhooks/model";

  let { id }: { id: string } = $props();
  const resource = new RemoteResource<WebhookDetail>();
  const delivery = $derived(resource.data?.delivery);
  let replayOpen = $state(false),
    busy = $state(false),
    refreshing = $state(false);
  async function load() {
    await resource.load((signal) => webhooks.detail(id, signal));
  }
  // Only a manual refresh disables the button; background polling would make it flicker.
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      await load();
    } finally {
      refreshing = false;
    }
  }
  onMount(() => {
    const pollIntervalInMs = 5000;

    void load();
    const timer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        Boolean(resource.loading) === false &&
        ["pending", "processing"].includes(delivery?.status ?? "")
      )
        void load();
    }, pollIntervalInMs);
    return () => {
      clearInterval(timer);
      resource.cancel();
    };
  });
  async function replay() {
    if (busy || delivery === undefined || canReplay(delivery) === false) return;
    busy = true;
    try {
      const result = await webhooks.replay(id);
      toast.success(t("webhooks.replayed"));
      navigate(`/webhooks/deliveries/${result.id}`);
    } catch (error) {
      toast.error(errorMessage(error));
      throw error;
    } finally {
      busy = false;
    }
  }
</script>

<div class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 *:mb-0 sm:px-6 lg:px-8">
  <!-- From md the top bar shows Webhooks > Delivery; phones hide that bar and keep the way back here. -->
  <nav
    class="flex flex-wrap items-center gap-2 text-sm md:hidden"
    aria-label={t("shell.nav.breadcrumb")}
  >
    <a
      class="text-muted-foreground hover:text-foreground hover:underline"
      href={href("/webhooks?tab=deliveries")}>{t("webhooks.deliveries")}</a
    >
    <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span aria-current="page">{t("webhooks.deliveryTitle", { id })}</span>
  </nav>
  <PageHeader
    title={t("webhooks.deliveryTitle", { id })}
    description={delivery
      ? `${delivery.endpoint_name} · ${delivery.schema}.${delivery.table} · ${eventLabel(delivery.event)}`
      : undefined}
  >
    {#snippet actions()}<Button variant="outline" onclick={refresh} disabled={refreshing}
        ><RefreshCw
          data-icon="inline-start"
          aria-hidden="true"
          class={refreshing ? "animate-spin" : ""}
        />{t("common.refresh")}</Button
      ><Button
        onclick={() => (replayOpen = true)}
        disabled={busy || !delivery || !canReplay(delivery)}>{t("webhooks.replay")}</Button
      >{/snippet}
  </PageHeader>
  {#if resource.error}<LoadError
      message={errorMessage(resource.error)}
      onretry={load}
      busy={resource.loading}
    />{/if}
  {#if !resource.data && resource.loading}<Skeleton class="h-40 rounded-3xl" />{/if}
  {#if resource.data && delivery}
    <section class="grid gap-4 rounded-3xl bg-card p-5">
      <div class="flex flex-wrap items-center gap-3">
        <Badge variant={statusVariant(delivery.status)}>{statusLabel(delivery.status)}</Badge><span
          class="text-sm text-muted-foreground"
          >{t("webhooks.attemptsOf", {
            done: delivery.attempts,
            count: delivery.max_attempts,
          })}</span
        >{#if !delivery.endpoint_enabled}<span class="text-sm text-muted-foreground"
            >{t("webhooks.paused")}</span
          >{/if}
      </div>
      {#if delivery.last_error}<p class="text-sm text-destructive">
          {failureLabel(delivery.last_error)}
        </p>{/if}
      <dl class="grid gap-4 text-sm sm:grid-cols-2">
        <div class="min-w-0">
          <dt class="text-muted-foreground">{t("webhooks.destination")}</dt>
          <dd class="mt-1 break-all">{delivery.url}</dd>
        </div>
        <div>
          <dt class="text-muted-foreground">{t("webhooks.sent")}</dt>
          <dd class="mt-1">{dateLabel(delivery.created_at)}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-muted-foreground">{t("webhooks.eventId")}</dt>
          <dd class="mt-1 break-all font-mono text-xs">{delivery.event_id}</dd>
        </div>
        {#if delivery.next_attempt_at}<div>
            <dt class="text-muted-foreground">{t("webhooks.nextAttempt")}</dt>
            <dd class="mt-1">{dateLabel(delivery.next_attempt_at)}</dd>
          </div>{/if}
      </dl>
      {#if delivery.replay_of}<a
          href={href(`/webhooks/deliveries/${delivery.replay_of}`)}
          class="text-sm text-brand underline"
          >{t("webhooks.replayOf", { id: delivery.replay_of })}</a
        >{/if}
    </section>
    <section class="grid gap-4 rounded-3xl bg-card p-5">
      <h2 class="font-semibold">{t("webhooks.attemptHistory")}</h2>
      {#if resource.data.attempts.length}
        <!-- Phones list the attempts one per row, like the delivery history, instead of a sideways table. -->
        <ol class="grid gap-3 text-sm sm:hidden">
          {#each resource.data.attempts as attempt (attempt.number)}<li
              class="grid gap-1 border-t border-border pt-3 first:border-0 first:pt-0"
            >
              <span class="flex flex-wrap justify-between gap-2"
                ><span class="font-medium">{t("webhooks.attempt")} {attempt.number}</span><span
                  >{attempt.status_code
                    ? `HTTP ${attempt.status_code}`
                    : attempt.finished_at
                      ? "—"
                      : statusLabel("processing")}</span
                ></span
              >
              <span class="text-xs text-muted-foreground tabular-nums"
                >{dateLabel(attempt.started_at)} · {durationLabel(attempt.duration_ms)}</span
              >
              {#if attempt.error}<span class="text-xs text-muted-foreground"
                  >{failureLabel(attempt.error)}</span
                >{/if}
            </li>{/each}
        </ol>
        <div class="overflow-x-auto max-sm:hidden">
          <table class="w-full text-left text-sm">
            <thead
              ><tr class="text-muted-foreground"
                ><th class="py-3 pr-4 font-medium">{t("webhooks.attempt")}</th><th
                  class="py-3 pr-4 font-medium">{t("webhooks.started")}</th
                ><th class="py-3 pr-4 font-medium">{t("webhooks.duration")}</th><th
                  class="py-3 font-medium">{t("webhooks.result")}</th
                ></tr
              ></thead
            ><tbody>
              {#each resource.data.attempts as attempt (attempt.number)}<tr
                  class="border-t border-border"
                  ><td class="py-3 pr-4 tabular-nums">{attempt.number}</td><td
                    class="py-3 pr-4 whitespace-nowrap">{dateLabel(attempt.started_at)}</td
                  ><td class="py-3 pr-4 whitespace-nowrap tabular-nums"
                    >{durationLabel(attempt.duration_ms)}</td
                  ><td class="py-3"
                    >{attempt.status_code
                      ? `HTTP ${attempt.status_code}`
                      : attempt.finished_at
                        ? "—"
                        : statusLabel("processing")}{#if attempt.error}<p
                        class="mt-1 text-xs text-muted-foreground"
                      >
                        {failureLabel(attempt.error)}
                      </p>{/if}</td
                  ></tr
                >{/each}
            </tbody>
          </table>
        </div>{/if}
      {#if !resource.data.attempts.length}<p class="text-sm text-muted-foreground">
          {t("webhooks.noAttempts")}
        </p>{/if}
    </section>
    <section class="grid gap-4 rounded-3xl bg-card p-5">
      <h2 class="font-semibold">{t("webhooks.payload")}</h2>
      <CodeBlock code={resource.data.payload} wrap />
    </section>
  {/if}
</div>
<ConfirmDialog
  bind:open={replayOpen}
  title={t("webhooks.replayTitle")}
  description={t("webhooks.replayHint")}
  confirmLabel={t("webhooks.replay")}
  onconfirm={replay}
/>
