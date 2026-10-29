<script lang="ts">
  import { intlLocale, t } from "$lib/i18n/index.svelte";
  const DECIMAL_SHARE_THRESHOLD = 0.1;
  const MIN_DISPLAYED_SHARE = 0.001;

  // A part of a whole as a bar (D98). The track is neutral so an empty meter
  // never reads as an alarm; only the fill takes the tone. Under it, the part and what it is a part of
  // ("190 of 8,592 · 2.2%"), so the second number never reads as a target.
  // The visible label sits with the page's other labels; `label` names the
  // meter for assistive technology.
  let {
    label,
    part,
    whole,
    format,
    tone = "warning",
  }: {
    label: string;
    part: number;
    whole: number;
    format: (n: number) => string;
    tone?: "warning" | "destructive";
  } = $props();
  const fill = { warning: "bg-warning", destructive: "bg-destructive" } as const;
  const ratio = $derived(whole > 0 ? Math.min(1, part / whole) : 0);
  // Small shares keep a decimal (2.2%); a share above zero never rounds to 0%.
  const pct = $derived(
    new Intl.NumberFormat(intlLocale(), {
      style: "percent",
      maximumFractionDigits: ratio > 0 && ratio < DECIMAL_SHARE_THRESHOLD ? 1 : 0,
    }),
  );
  const share = $derived(
    ratio > 0 && ratio < MIN_DISPLAYED_SHARE
      ? `<${pct.format(MIN_DISPLAYED_SHARE)}`
      : pct.format(ratio),
  );
</script>

<div class="grid min-w-0 gap-2 sm:min-w-36">
  <div
    class="h-2 overflow-hidden rounded-full bg-muted"
    role="meter"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={whole}
    aria-valuenow={part}
    aria-valuetext={whole > 0
      ? t("overview.hero.share", { part: format(part), whole: format(whole), percent: share })
      : format(part)}
  >
    <div class={["h-full rounded-full", fill[tone]]} style:width={`${ratio * 100}%`}></div>
  </div>
  <p class="flex flex-wrap items-baseline gap-x-1 text-xs tabular-nums" aria-hidden="true">
    <span class="font-medium">{format(part)}</span>
    {#if whole > 0}<span class="text-muted-foreground"
        >{t("overview.hero.ofTotal", { whole: format(whole), percent: share })}</span
      >{/if}
  </p>
</div>
