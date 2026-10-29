<script lang="ts">
  import * as InputGroup from "$lib/components/ui/input-group";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import { t } from "$lib/i18n/index.svelte";

  let {
    value = $bindable(""),
    label,
    placeholder = label,
    oninput,
  }: {
    value?: string;
    label: string;
    placeholder?: string;
    oninput?: () => void;
  } = $props();
  let input = $state<HTMLInputElement | null>(null);

  function clear() {
    value = "";
    oninput?.();
    input?.focus();
  }
</script>

<InputGroup.Root>
  <InputGroup.Input
    bind:ref={input}
    bind:value
    type="search"
    aria-label={label}
    {placeholder}
    autocomplete="off"
    spellcheck={false}
    oninput={() => oninput?.()}
    class="[&::-webkit-search-cancel-button]:appearance-none"
  />
  <InputGroup.Addon><Search aria-hidden="true" /></InputGroup.Addon>
  {#if value}
    <InputGroup.Addon align="inline-end">
      <InputGroup.Button size="icon-sm" aria-label={t("common.clearSearch")} onclick={clear}
        ><X aria-hidden="true" /></InputGroup.Button
      >
    </InputGroup.Addon>
  {/if}
</InputGroup.Root>
