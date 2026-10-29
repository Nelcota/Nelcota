<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import CodeBlock from "../code-block.svelte";
  import { Button } from "$lib/components/ui/button";
  import { t } from "$lib/i18n/index.svelte";

  let {
    open = $bindable(false),
    title,
    value,
  }: { open?: boolean; title: string; value: string | null } = $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-3xl">
    <Dialog.Header><Dialog.Title>{title}</Dialog.Title></Dialog.Header>
    <CodeBlock code={value ?? "NULL"} wrap />
    <Dialog.Footer
      ><Button variant="outline" onclick={() => (open = false)}>{t("common.close")}</Button
      ></Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>
