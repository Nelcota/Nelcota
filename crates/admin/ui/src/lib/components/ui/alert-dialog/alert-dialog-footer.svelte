<script lang="ts">
  import { cn, type WithElementRef } from "$lib/components/component-props.js";
  import type { HTMLAttributes } from "svelte/elements";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
  bind:this={ref}
  data-slot="alert-dialog-footer"
  class={cn(
    "bg-muted/40 -mx-6 -mb-6 mt-1 rounded-b-lg border-t px-6 py-4 flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
