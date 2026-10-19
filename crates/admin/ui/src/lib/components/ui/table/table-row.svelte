<script lang="ts">
	import { cn, type WithElementRef } from "$lib/components/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLTableRowElement>> = $props();
</script>

<tr
	bind:this={ref}
	data-slot="table-row"
	class={cn("hover:bg-accent/40 data-[state=selected]:bg-muted border-b last:border-b-0 transition-colors has-aria-expanded:bg-muted/50", className)}
	{...restProps}
>
	{@render children?.()}
</tr>
