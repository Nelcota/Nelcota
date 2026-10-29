<script lang="ts">
  import { formatCell } from "$lib/features/tables/format";
  import {
    alignRight,
    compactJsonPreview,
    monospace,
    shortUuid,
    type ColumnKind,
  } from "$lib/features/tables/rows/grid";

  let { value, type, kind }: { value: string | null; type: string; kind: ColumnKind } = $props();

  const display = $derived(value === null ? null : formatCell(value, type));
  /** JSON on a single line, computed once per value: the cell shows the start; the detail dialog has it all. */
  const json = $derived(kind === "json" && value !== null ? compactJsonPreview(value) : "");
</script>

<!-- Display only; editing and the tooltip use the exact value. -->
<span
  class={[
    "block truncate",
    alignRight(kind) && "text-right tabular-nums",
    monospace(kind) && "font-mono text-[0.95em]",
    kind === "temporal" && "tabular-nums",
  ]}
>
  {#if value === null}
    <span class="font-mono text-3xs text-muted-foreground/80">NULL</span>
  {/if}
  {#if !(value === null) && kind === "boolean"}
    <span class={["font-mono", value === "true" ? "text-foreground" : "text-muted-foreground"]}
      >{value}</span
    >
  {/if}
  {#if !(value === null) && !(kind === "boolean") && kind === "enum"}
    <span class="rounded-full bg-well px-2 py-0.5 text-2xs">{value}</span>
  {/if}
  {#if !(value === null) && !(kind === "boolean") && !(kind === "enum") && kind === "uuid" && shortUuid(value) !== value}
    <!-- Shortened on screen; assistive tech and the tooltip get the whole id. -->
    <span aria-hidden="true">{shortUuid(value)}</span><span class="sr-only">{value}</span>
  {/if}
  {#if !(value === null) && !(kind === "boolean") && !(kind === "enum") && !(kind === "uuid" && shortUuid(value) !== value) && kind === "json"}
    <span class="text-muted-foreground">{json}</span>
  {/if}
  {#if !(value === null) && !(kind === "boolean") && !(kind === "enum") && !(kind === "uuid" && shortUuid(value) !== value) && !(kind === "json")}
    {display?.text}
  {/if}
</span>
