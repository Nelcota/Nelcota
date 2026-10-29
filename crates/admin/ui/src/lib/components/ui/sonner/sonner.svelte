<script lang="ts">
  import { mode } from "mode-watcher";
  import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";
  import Loader2Icon from "@lucide/svelte/icons/loader-2";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import OctagonXIcon from "@lucide/svelte/icons/octagon-x";
  import InfoIcon from "@lucide/svelte/icons/info";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

  let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
  theme={mode.current}
  class="toaster group"
  style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border-strong); --border-radius: 0.5rem;"
  toastOptions={{
    classes: {
      toast: "cn-toast shadow-overlay! text-sm! gap-3! px-4! py-3!",
      error: "[&_[data-icon]]:text-destructive!",
      warning: "[&_[data-icon]]:text-warning!",
    },
  }}
  {...restProps}
>
  {#snippet loadingIcon()}
    <Loader2Icon class="size-4 animate-spin" />
  {/snippet}
  {#snippet successIcon()}
    <CircleCheckIcon class="size-[18px]" />
  {/snippet}
  {#snippet errorIcon()}
    <OctagonXIcon class="size-[18px]" />
  {/snippet}
  {#snippet infoIcon()}
    <InfoIcon class="size-[18px]" />
  {/snippet}
  {#snippet warningIcon()}
    <TriangleAlertIcon class="size-[18px]" />
  {/snippet}
</Sonner>
