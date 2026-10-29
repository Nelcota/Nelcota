<script lang="ts">
  import { backupTime } from "../model/recovery";
  import { hostText as h } from "../model";
  import { intlLocale } from "$lib/i18n/index.svelte";
  let { backup, resuming }: { backup: string; resuming: boolean } = $props();
  const point = $derived(backupTime(backup));
  const date = $derived(
    point === null
      ? null
      : new Intl.DateTimeFormat(intlLocale(), {
          dateStyle: "medium",
          timeStyle: "long",
          timeZone: "UTC",
        }).format(new Date(point)),
  );
</script>

<dl class="mt-3 grid gap-2 text-sm">
  <div>
    <dt class="text-muted-foreground">{h("backupFile")}</dt>
    <dd class="break-all font-mono" translate="no">{backup}</dd>
  </div>
  <div>
    <dt class="text-muted-foreground">{h("recoveryPoint")}</dt>
    <dd>{date ?? h("recoveryPointUnknown")}</dd>
  </div>
  <div>
    <dt class="text-muted-foreground">{h("recoveryScope")}</dt>
    <dd>{h(resuming ? "recoveryVerificationOnly" : "recoveryPair")}</dd>
  </div>
</dl>
<p class="mt-3 text-sm">{h(resuming ? "recoveryVerify" : "recoverySafety")}</p>
