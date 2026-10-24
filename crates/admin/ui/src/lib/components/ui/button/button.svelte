<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn, type WithElementRef } from "$lib/components/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	export const buttonVariants = tv({
		base: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-xl border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 cursor-pointer aria-invalid:ring-3 active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-primary-hover",
				outline: "border-border bg-field hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
				secondary: "bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-accent aria-expanded:text-secondary-foreground",
				ghost: "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
				destructive: "border-destructive/25 bg-destructive/10 hover:bg-destructive/20 hover:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/15 text-destructive focus-visible:border-destructive/40 dark:hover:bg-destructive/20",
				link: "text-brand underline-offset-4 hover:underline",
			},
			size: {
				default: "h-10 gap-2 px-4 has-data-[icon=inline-end]:pr-3.5 has-data-[icon=inline-start]:pl-3.5",
				xs: "h-7 gap-1 px-2.5 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-9 gap-1.5 px-3.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-3 [&_svg:not([class*='size-'])]:size-4",
				lg: "h-12 gap-2 px-6 text-base has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5 [&_svg:not([class*='size-'])]:size-[18px]",
				icon: "size-10",
				"icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-9",
				"icon-lg": "size-12",
				// Onboarding and sign-in calls to action only; regular primary actions keep `default`.
				hero: "h-15 min-w-[min(15.75rem,100%)] max-w-full gap-3 rounded-[16px] px-5 text-lg leading-tight whitespace-normal sm:px-6 sm:text-xl [&_svg]:size-5",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if (href)}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{/if}
{#if !(href)}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
