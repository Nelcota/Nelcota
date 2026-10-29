<script lang="ts">
  import { numberFormat } from "$lib/formatting/intl";
  import { intlLocale } from "$lib/i18n/index.svelte";
  let { values, labels, describe }: { values: number[]; labels: string[]; describe: string } =
    $props();
  const format = (value: number) => numberFormat(intlLocale()).format(value);
  const max = $derived(Math.max(1, ...values));
</script>

<div class="flex h-14 shrink-0 items-end gap-1" role="img" aria-label={describe}>
  {#each values as value, i (i)}
    <div
      class={[
        "w-2 rounded-t-[4px] rounded-b-[2px]",
        i === values.length - 1 ? "bg-brand" : "bg-muted-foreground/25",
      ]}
      style:height={`${Math.max(6, (value / max) * 100)}%`}
      title={`${labels[i] ?? ""}: ${format(value)}`}
    ></div>
  {/each}
</div>
