<script lang="ts">
	import * as ResizablePrimitive from "paneforge";
	import { cn, type WithoutChildrenOrChild } from "$lib/components/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		withHandle = false,
		...restProps
	}: WithoutChildrenOrChild<ResizablePrimitive.PaneResizerProps> & {
		withHandle?: boolean;
	} = $props();
</script>

<ResizablePrimitive.PaneResizer
	bind:ref
	data-slot="resizable-handle"
	class={cn(
		"group relative flex w-px items-center justify-center bg-border transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 hover:bg-border-strong data-[active]:bg-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden data-[direction=vertical]:h-px data-[direction=vertical]:w-full data-[direction=vertical]:after:left-0 data-[direction=vertical]:after:h-3 data-[direction=vertical]:after:w-full data-[direction=vertical]:after:translate-x-0 data-[direction=vertical]:after:-translate-y-1/2 [&[data-direction=vertical]>div]:rotate-90",
		className
	)}
	{...restProps}
>
	{#if withHandle}
		<!-- Shows itself on hover and while dragging. -->
		<div class="z-10 flex h-8 w-1.5 shrink-0 rounded-full bg-border-strong transition-colors group-hover:bg-muted-foreground group-data-[active]:bg-ring"></div>
	{/if}
</ResizablePrimitive.PaneResizer>
