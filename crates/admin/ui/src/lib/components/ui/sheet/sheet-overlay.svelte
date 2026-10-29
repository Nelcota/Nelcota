<script lang="ts">
  import { Dialog as SheetPrimitive } from "bits-ui";
  import { cn } from "$lib/components/component-props.js";

  let {
    ref = $bindable(null),
    class: className,
    ...restProps
  }: SheetPrimitive.OverlayProps = $props();
</script>

<SheetPrimitive.Overlay
  bind:ref
  data-slot="sheet-overlay"
  class={cn(
    "bg-black/40 dark:bg-black/60 fixed inset-0 z-50 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
    className,
  )}
  {...restProps}
/>
