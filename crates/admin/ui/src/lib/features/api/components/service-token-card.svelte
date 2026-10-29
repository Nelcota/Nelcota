<script lang="ts">
  import { dateText } from "$lib/formatting/date";
  import * as Select from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { KeyRound, TriangleAlert, LoaderCircle, Eye, EyeOff, Copy } from "@lucide/svelte";

  import { toast } from "svelte-sonner";
  import ConfirmDialog from "$lib/components/shared/dialogs/confirm-dialog.svelte";
  import { copyText } from "$lib/browser/clipboard";
  import { api } from "$lib/transport/api";
  import { errorMessage, intlLocale, t } from "$lib/i18n/index.svelte";
  const TOKEN_MASK_LENGTH = 48;
  const SECOND_IN_MS = 1000;

  const DURATIONS = ["30", "90", "365"];
  const durationLabel = (days: string) =>
    days === "365" ? t("connect.token.oneYear") : t("connect.token.days", { count: Number(days) });

  let days = $state("90");
  let issued = $state<{ token: string; expires_at: number } | null>(null);
  let busy = $state(false);
  let confirmOpen = $state(false);
  let revealed = $state(false);

  // Fixed length, so the mask does not leak the token's size.
  const MASK = "•".repeat(TOKEN_MASK_LENGTH);

  // Runs from the confirmation: rethrowing keeps the dialog open to try again.
  async function issue() {
    if (busy) return;
    busy = true;
    try {
      issued = await api.post<{ token: string; expires_at: number }>("/tokens/service-role", {
        days: Number(days),
      });
      revealed = false;
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    } finally {
      busy = false;
    }
  }

  const expires = (epoch: number) =>
    dateText(
      epoch * SECOND_IN_MS,
      new Intl.DateTimeFormat(intlLocale(), { dateStyle: "long" }).format,
    );
</script>

<!-- The token is not stored: it shows once, here, to be copied. -->
<section class="grid gap-4 rounded-3xl bg-card p-6">
  <div>
    <h2 class="text-lg font-semibold">
      {t("connect.token.title")} <code class="font-mono">service_role</code>
    </h2>
    <p class="mt-1 text-sm text-muted-foreground">{t("connect.token.intro")}</p>
  </div>
  <!-- A standing warning, not a live alert: plain markup instead of role="alert". -->
  <div class="flex items-start gap-3 rounded-2xl bg-warning/10 px-4 py-3 text-sm">
    <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
    <p>
      <span class="font-medium text-warning">{t("connect.token.warningTitle")}.</span>
      <span class="text-muted-foreground">{t("connect.token.warning")}</span>
    </p>
  </div>
  <p class="text-sm text-muted-foreground">{t("connect.token.details")}</p>

  {#if issued}
    <div class="grid gap-2">
      <!-- Masked until asked: the screen may be shared or recorded. Copy always takes the real value. -->
      <div class="flex min-w-0 items-start gap-1 rounded-xl bg-well py-1.5 pr-1.5 pl-4">
        <code
          class="min-w-0 flex-1 py-2 font-mono text-xs leading-relaxed break-all sm:text-[0.8125rem]"
        >
          {#if revealed}{issued.token}{/if}
          {#if !revealed}<span aria-hidden="true">{MASK}</span><span class="sr-only"
              >{t("connect.token.hidden")}</span
            >{/if}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("connect.token.reveal")}
          aria-pressed={revealed}
          onclick={() => (revealed = !revealed)}
        >
          {#if revealed}<EyeOff aria-hidden="true" />{/if}
          {#if !revealed}<Eye aria-hidden="true" />{/if}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("connect.token.copy")}
          onclick={() => copyText(issued!.token)}
        >
          <Copy aria-hidden="true" />
        </Button>
      </div>
      <p class="text-sm text-warning">
        {t("connect.token.copyNow", { date: expires(issued.expires_at) })}
      </p>
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <Select.Root type="single" bind:value={days}>
      <Select.Trigger class="w-36" aria-label={t("connect.token.validity")}>
        {durationLabel(days)}
      </Select.Trigger>
      <Select.Content>
        {#each DURATIONS as duration (duration)}
          <Select.Item value={duration}>{durationLabel(duration)}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <Button variant="outline" disabled={busy} onclick={() => (confirmOpen = true)}>
      {#if busy}<LoaderCircle
          data-icon="inline-start"
          class="animate-spin"
          aria-hidden="true"
        />{/if}
      {#if !busy}<KeyRound data-icon="inline-start" aria-hidden="true" />{/if}
      {busy
        ? t("connect.token.generating")
        : issued
          ? t("connect.token.generateAnother")
          : t("connect.token.generate")}
    </Button>
    <span class="text-sm text-muted-foreground">
      {t("connect.token.orOnServer")}
      <code class="text-xs text-foreground">nelcota token service-role</code>
    </span>
  </div>
</section>

<ConfirmDialog
  bind:open={confirmOpen}
  title={t("connect.token.confirmTitle")}
  description={t("connect.token.confirmDescription", { validity: durationLabel(days) })}
  confirmLabel={t("connect.token.generate")}
  destructive
  onconfirm={issue}
/>
