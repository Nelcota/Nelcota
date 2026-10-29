<script lang="ts">
  import { Command as CommandPrimitive } from "bits-ui";
  import { cn } from "$lib/components/component-props.js";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: CommandPrimitive.ListProps = $props();
</script>

<CommandPrimitive.List
  bind:ref
  data-slot="command-list"
  tabindex={0}
  class={cn(
    "no-scrollbar max-h-96 scroll-py-1 overflow-x-hidden overflow-y-auto focus-visible:outline-offset-[-2px]",
    className,
  )}
  {...restProps}
>
  <!-- Bits UI uses the viewport to connect the search field to its options
	     with aria-controls and aria-activedescendant. -->
  <CommandPrimitive.Viewport>
    {@render children?.()}
  </CommandPrimitive.Viewport>
</CommandPrimitive.List>
