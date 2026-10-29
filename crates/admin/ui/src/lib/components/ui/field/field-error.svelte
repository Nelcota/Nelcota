<script lang="ts">
  import { cn, type WithElementRef } from "$lib/components/component-props.js";
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  let {
    ref = $bindable(null),
    class: className,
    children,
    errors,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    children?: Snippet;
    errors?: { message?: string }[];
  } = $props();

  const hasContent = $derived.by(() => {
    // has slotted error
    if (children != null) return true;

    // no errors
    if (errors == null || errors.length === 0) return false;

    // has an error but no message
    const message = errors.at(0)?.message;
    if (errors.length === 1 && (message == null || message === "")) {
      return false;
    }

    return true;
  });

  const isMultipleErrors = $derived(errors != null && errors.length > 1);
  const singleErrorMessage = $derived(errors?.length === 1 ? errors.at(0)?.message : undefined);
</script>

{#if hasContent}
  <div
    bind:this={ref}
    role="alert"
    data-slot="field-error"
    class={cn("text-destructive text-sm font-normal", className)}
    {...restProps}
  >
    {#if children}
      {@render children()}
    {/if}
    {#if !children && singleErrorMessage}
      {singleErrorMessage}
    {/if}
    {#if !children && !singleErrorMessage && isMultipleErrors}
      <ul class="ml-4 flex list-disc flex-col gap-1">
        {#each errors ?? [] as error, index (index)}
          {#if error?.message}
            <li>{error.message}</li>
          {/if}
        {/each}
      </ul>
    {/if}
  </div>
{/if}
