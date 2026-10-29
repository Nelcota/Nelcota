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
  data-slot="dialog-header"
  class={cn("min-w-0 gap-2 pr-6 flex flex-col [overflow-wrap:anywhere]", className)}
  {...restProps}
>
  {@render children?.()}
</div>
