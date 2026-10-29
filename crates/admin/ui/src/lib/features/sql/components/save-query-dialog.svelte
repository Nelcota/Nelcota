<script lang="ts">
  import { untrack } from "svelte";
  import { CloseGuard } from "$lib/forms/close-guard.svelte";
  import UnsavedChangesDialog from "$lib/components/shared/dialogs/unsaved-changes-dialog.svelte";
  import Save from "@lucide/svelte/icons/save";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { t } from "$lib/i18n/index.svelte";

  let {
    open = $bindable(false),
    title,
    initialName = "",
    confirmLabel,
    onsubmit,
  }: {
    open?: boolean;
    title: string;
    initialName?: string;
    confirmLabel?: string;
    onsubmit: (name: string) => void;
  } = $props();

  let name = $state("");
  let originalName = $state("");
  const guard = new CloseGuard({
    dirty: () => name !== originalName,
    busy: () => false,
    close: () => (open = false),
    active: () => open,
  });

  // Fill the field on every open (save and rename share this dialog).
  $effect(() => {
    if (open)
      untrack(() => {
        name = initialName;
        originalName = initialName;
      });
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    onsubmit(trimmed);
    open = false;
  }
</script>

<Dialog.Root bind:open={() => open, guard.change}>
  <Dialog.Content class="sm:max-w-md">
    <form class="grid gap-5" onsubmit={submit}>
      <Dialog.Header>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{t("sql.dialog.description")}</Dialog.Description>
      </Dialog.Header>
      <div class="grid gap-2">
        <Label for="query-name">{t("common.name")}</Label>
        <Input
          id="query-name"
          bind:value={name}
          placeholder={t("sql.dialog.placeholder")}
          maxlength={120}
        />
      </div>
      <Dialog.Footer>
        <Button variant="outline" onclick={guard.request}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={!name.trim()}
          ><Save data-icon="inline-start" aria-hidden="true" />{confirmLabel ??
            t("common.save")}</Button
        >
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
