<script lang="ts">
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { buttonVariants } from "$lib/components/ui/button";
  import { t } from "$lib/i18n/index.svelte";

  let { open = $bindable(false), ondiscard }: { open?: boolean; ondiscard: () => void } = $props();
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{t("common.unsavedTitle")}</AlertDialog.Title>
      <AlertDialog.Description>{t("common.unsavedDescription")}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{t("common.keepEditing")}</AlertDialog.Cancel>
      <AlertDialog.Action class={buttonVariants({ variant: "destructive" })} onclick={ondiscard}
        >{t("common.discard")}</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
