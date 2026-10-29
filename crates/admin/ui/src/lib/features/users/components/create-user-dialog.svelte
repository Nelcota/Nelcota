<script lang="ts">
  import { CloseGuard } from "$lib/forms/close-guard.svelte";
  import UnsavedChangesDialog from "$lib/components/shared/dialogs/unsaved-changes-dialog.svelte";
  import { UserPlus, LoaderCircle } from "@lucide/svelte";

  import { Dialog, Button, Input, Field } from "$lib/components/ui";

  import { toast } from "svelte-sonner";
  import PasswordField from "$lib/components/shared/inputs/password-field.svelte";
  import { api } from "$lib/transport/api";
  import { passwordProblem } from "$lib/forms/password";
  import { errorMessage, t } from "$lib/i18n/index.svelte";

  let { open = $bindable(false), oncreated }: { open?: boolean; oncreated: () => void } = $props();

  let email = $state("");
  let password = $state("");
  let saving = $state(false);
  let emailInvalid = $state(false);
  let emailTouched = $state(false);
  let failure = $state("");
  const guard = new CloseGuard({
    dirty: () => email !== "" || password !== "",
    busy: () => saving,
    close: () => (open = false),
    active: () => open,
  });

  $effect(() => {
    if (open) {
      email = "";
      password = "";
      emailInvalid = false;
      emailTouched = false;
      failure = "";
    }
  });

  const ready = $derived(
    email.trim() !== "" && emailInvalid === false && Boolean(passwordProblem(password)) === false,
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving || ready === false) return;
    saving = true;
    failure = "";
    try {
      const result = await api.post<{ email: string }>("/users", { email, password });
      toast.success(t("users.create.created", { email: result.email }));
      open = false;
      oncreated();
    } catch (e) {
      failure = errorMessage(e);
    } finally {
      saving = false;
    }
  }
</script>

<Dialog.Root bind:open={() => open, guard.change}>
  <Dialog.Content class="sm:max-w-lg">
    <form class="grid gap-5" onsubmit={submit}>
      <fieldset class="contents" disabled={saving} aria-busy={saving}>
        <Dialog.Header>
          <Dialog.Title>{t("users.new")}</Dialog.Title>
          <Dialog.Description>{t("users.create.description")}</Dialog.Description>
        </Dialog.Header>
        <Field.Group class="gap-5">
          <Field.Field data-invalid={emailTouched && emailInvalid}>
            <Field.Label for="new-user-email">{t("users.columns.email")}</Field.Label>
            <Input
              id="new-user-email"
              name="email"
              type="email"
              bind:value={email}
              oninput={(event) =>
                (emailInvalid =
                  event.currentTarget.value !== "" && !event.currentTarget.validity.valid)}
              onblur={() => (emailTouched = true)}
              placeholder={t("users.create.emailPlaceholder")}
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              aria-invalid={emailTouched && emailInvalid}
              aria-describedby={emailTouched && emailInvalid ? "new-user-email-error" : undefined}
              required
            />
            {#if emailTouched && emailInvalid}<Field.Error id="new-user-email-error"
                >{t("users.create.invalidEmail")}</Field.Error
              >{/if}
          </Field.Field>
          <Field.Field data-invalid={password !== "" && !!passwordProblem(password)}>
            <Field.Label for="new-user-password">{t("users.create.password")}</Field.Label>
            <PasswordField id="new-user-password" bind:value={password} />
          </Field.Field>
        </Field.Group>
        {#if failure}<Field.Error>{failure}</Field.Error>{/if}
        <Dialog.Footer>
          <Button variant="outline" disabled={saving} onclick={guard.request}
            >{t("common.cancel")}</Button
          >
          <Button type="submit" disabled={saving || !ready}
            >{#if saving}<LoaderCircle
                data-icon="inline-start"
                class="animate-spin"
                aria-hidden="true"
              />{/if}{#if !saving}<UserPlus
                data-icon="inline-start"
                aria-hidden="true"
              />{/if}{saving ? t("common.creating") : t("users.create.submit")}</Button
          >
        </Dialog.Footer>
      </fieldset>
    </form>
  </Dialog.Content>
</Dialog.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
