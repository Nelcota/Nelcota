<script lang="ts">
  import { Dialog as DialogPrimitive } from "bits-ui";
  import { Button } from "$lib/components/ui/button/index.js";
  import { cn, type WithElementRef } from "$lib/components/component-props.js";
  import type { HTMLAttributes } from "svelte/elements";

  let {
    ref = $bindable(null),
    class: className,
    children,
    showCloseButton = false,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    showCloseButton?: boolean;
  } = $props();
</script>

<div
  bind:this={ref}
  data-slot="dialog-footer"
  class={cn(
    "bg-muted/40 -mx-6 -mb-6 mt-1 rounded-b-lg border-t px-6 py-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
  {#if showCloseButton}
    <DialogPrimitive.Close>
      {#snippet child({ props })}
        <Button variant="outline" {...props}>Close</Button>
      {/snippet}
    </DialogPrimitive.Close>
  {/if}
</div>
