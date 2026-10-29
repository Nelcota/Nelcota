<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import SearchIcon from "@lucide/svelte/icons/search";
  import { cn } from "$lib/components/component-props.js";

  let {
    ref = $bindable(null),
    class: className,
    value = $bindable(""),
    ...restProps
  }: CommandPrimitive.InputProps = $props();
</script>

<!-- Plain field with an icon (without the input-group of the "nova" style). -->
<div data-slot="command-input-wrapper" class="flex items-center gap-2.5 border-b px-4">
  <SearchIcon class="size-4 shrink-0 text-muted-foreground" />
  <CommandPrimitive.Input
    bind:value
    bind:ref
    data-slot="command-input"
    class={cn(
      "h-14 w-full bg-transparent text-base outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...restProps}
  />
</div>
