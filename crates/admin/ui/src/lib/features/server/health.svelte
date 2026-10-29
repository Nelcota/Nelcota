<script lang="ts">
  import { onDestroy } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { i18n, translate } from "$lib/i18n/index.svelte";
  import { dateTimeText } from "$lib/formatting/date";
  import { numberFormat } from "$lib/formatting/intl";
  import { RemoteResource } from "$lib/resources/remote-resource.svelte";
  import { formatGibibytes } from "../storage/files";
  import { request, sessionExpired } from "../updates/controller";
  import { parseDiagnostics, type Diagnostics } from "./contracts";
  let { project, expired }: { project: string; expired: () => void } = $props();
  const diagnostics = new RemoteResource<Diagnostics>();
  const data = $derived(diagnostics.data),
    loading = $derived(diagnostics.loading);
  const error = $derived(diagnostics.error !== null && sessionExpired(diagnostics.error) === false);
  const s = (key: string) => translate(i18n.locale, `server.${key}`);
  const size = (bytes: number | null) =>
    bytes === null ? s("unavailable") : formatGibibytes(bytes, i18n.locale);
  async function load() {
    const selected = project;
    const loaded = await diagnostics.load(async (signal) => {
      const reply = await request({ action: "host_diagnostics", project: selected }, signal);
      const next = parseDiagnostics(reply.data);
      if (next.project !== selected) throw new Error("project mismatch");
      return next;
    });
    if (loaded === false && sessionExpired(diagnostics.error)) expired();
  }
  $effect(() => {
    if (project !== "") {
      diagnostics.data = null;
      void load();
    }
  });
  onDestroy(() => diagnostics.cancel());
</script>

<section
  class="grid gap-5 rounded-3xl border border-border bg-card p-6"
  aria-busy={loading}
  aria-labelledby="server-health-title"
>
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h2 id="server-health-title" class="text-xl font-semibold">{s("health")}</h2>
      <p class="mt-1 text-sm text-muted-foreground">{s("readOnly")}</p>
    </div>
    <Button disabled={loading || !project} onclick={() => void load()}
      >{loading ? s("refreshing") : s("diagnose")}</Button
    >
  </div>
  {#if error}<p role="alert" class="text-sm text-destructive">{s("error")}</p>{/if}
  {#if data}<p class="text-xs text-muted-foreground">
      {s("checked")}: {dateTimeText(data.checked_at * 1000, i18n.locale)}
    </p>
    <dl class="grid gap-3 sm:grid-cols-2">
      {#each [[s("cpu"), data.cpu_percent === null ? s("unavailable") : numberFormat( i18n.locale, { style: "percent", maximumFractionDigits: 1 } ).format(data.cpu_percent / 100)], [s("memory"), `${size(data.memory_available_bytes)} / ${size(data.memory_total_bytes)}`], [s("disk"), size(data.free_bytes)], [s("load"), data.load_one === null ? s("unavailable") : numberFormat( i18n.locale, { maximumFractionDigits: 2 } ).format(data.load_one)]] as [label, value]}
        <div class="rounded-2xl bg-well p-4">
          <dt class="text-sm text-muted-foreground">{label}</dt>
          <dd class="mt-1 text-xl font-semibold">{value}</dd>
        </div>
      {/each}
    </dl>
    <ul class="grid gap-2">
      {#each data.checks as check (check.name)}<li
          class="flex items-center justify-between gap-4 rounded-2xl border border-border px-4 py-3"
        >
          <span>{s(check.name) === `server.${check.name}` ? s("unavailable") : s(check.name)}</span
          ><span
            class={`text-sm font-medium ${check.status === "failed" ? "text-destructive" : check.status === "passed" ? "text-success" : "text-warning"}`}
            >{s(check.status)}</span
          >
        </li>{/each}
    </ul>
  {/if}
  <p class="text-sm text-muted-foreground">{s("pendingUpdate")}</p>
</section>
