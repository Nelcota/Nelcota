<script lang="ts">
  import { Ellipsis, Copy, KeyRound, MailCheck, LogOut, Trash as Trash2 } from "@lucide/svelte";
  import { Button, DropdownMenu } from "$lib/components/ui";
  import { copyText } from "$lib/browser/clipboard";
  import type { User } from "$lib/contracts/types";
  import { t } from "$lib/i18n/index.svelte";
  let {
    user,
    onpassword,
    onconfirm,
    onask,
  }: {
    user: User;
    onpassword: (user: User) => void;
    onconfirm: (user: User) => Promise<void>;
    onask: (user: User, action: "revoke" | "delete") => void;
  } = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("common.actionsFor", { name: user.email })}
        {...props}><Ellipsis aria-hidden="true" /></Button
      >
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-56">
    <DropdownMenu.Group>
      <DropdownMenu.Item onclick={() => copyText(user.id, t("users.idCopied"))}
        ><Copy aria-hidden="true" />{t("users.copyId")}</DropdownMenu.Item
      >
      <DropdownMenu.Item onclick={() => onpassword(user)}
        ><KeyRound aria-hidden="true" />{t("users.resetPassword")}</DropdownMenu.Item
      >
      {#if !user.email_confirmed_at}
        <DropdownMenu.Item onclick={() => onconfirm(user)}
          ><MailCheck aria-hidden="true" />{t("users.confirmEmail")}</DropdownMenu.Item
        >
      {/if}
      <DropdownMenu.Item onclick={() => onask(user, "revoke")}
        ><LogOut aria-hidden="true" />{t("users.revokeSessions")}</DropdownMenu.Item
      >
    </DropdownMenu.Group>
    <DropdownMenu.Separator />
    <DropdownMenu.Group
      ><DropdownMenu.Item variant="destructive" onclick={() => onask(user, "delete")}
        ><Trash2 aria-hidden="true" />{t("users.delete")}</DropdownMenu.Item
      ></DropdownMenu.Group
    >
  </DropdownMenu.Content>
</DropdownMenu.Root>
