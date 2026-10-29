<script lang="ts">
  import type { Snippet } from "svelte";
  import * as Alert from "$lib/components/ui/alert";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";

  // Block notice for alerts that need attention (security, data loss).
  let {
    variant = "warning",
    title,
    children,
    class: className = "",
    actions,
  }: {
    variant?: "warning" | "danger";
    title?: string;
    children?: Snippet;
    class?: string;
    actions?: Snippet;
  } = $props();
</script>

<Alert.Root
  variant={variant === "danger" ? "destructive" : "default"}
  class={[
    "rounded-2xl px-4 py-3 text-sm",
    variant === "danger" ? "bg-destructive/10" : "bg-warning/10",
    className,
  ]}
>
  {#if variant === "danger"}<ShieldAlert aria-hidden="true" />{/if}
  {#if !(variant === "danger")}<CircleAlert aria-hidden="true" />{/if}
  {#if title}
    <Alert.Title class={["font-medium", variant === "danger" ? "text-destructive" : "text-warning"]}
      >{title}</Alert.Title
    >
  {/if}
  {#if children}
    <Alert.Description
      class={[
        title
          ? "mt-1 text-muted-foreground"
          : variant === "danger"
            ? "text-destructive"
            : "text-warning",
      ]}
    >
      {@render children()}
    </Alert.Description>
  {/if}
  {#if actions}<div class="col-start-2 mt-3 flex flex-wrap gap-2">{@render actions()}</div>{/if}
</Alert.Root>
