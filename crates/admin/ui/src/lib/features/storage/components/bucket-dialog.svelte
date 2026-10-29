<script lang="ts">
  import { untrack } from "svelte";
  import { CloseGuard } from "$lib/forms/close-guard.svelte";
  import { UnsavedChangesDialog, ConfirmDialog, Callout } from "$lib/components/shared";

  import { Save, HardDrive, LoaderCircle } from "@lucide/svelte";

  import { Dialog, Button, Input, Field, Checkbox } from "$lib/components/ui";

  import { toast } from "svelte-sonner";
  import { api, enc } from "$lib/transport/api";
  import { formatBytes, parseTypes, validBucketName } from "$lib/features/storage/files";
  import type { Bucket } from "$lib/contracts/types";
  import { errorMessage, intlLocale, t } from "$lib/i18n/index.svelte";

  // Creates a bucket, or edits one when `bucket` is given.
  let {
    open = $bindable(false),
    bucket = null,
    serverLimit,
    onsaved,
  }: {
    open?: boolean;
    bucket?: Bucket | null;
    serverLimit: number;
    onsaved: () => void;
  } = $props();

  const MB = 1_048_576;

  let id = $state("");
  let isPublic = $state(false);
  let limitMb = $state("");
  let initialLimitMb = $state("");
  let initialLimit = $state<number | null>(null);
  let types = $state("");
  let saving = $state(false);
  let failure = $state("");
  let confirmPublicOpen = $state(false);
  let initialValue = $state("");
  const snapshot = () => JSON.stringify([id, isPublic, limitMb, types]);
  const guard = new CloseGuard({
    dirty: () => snapshot() !== initialValue,
    busy: () => saving,
    close: () => (open = false),
    active: () => open,
  });

  $effect(() => {
    if (open) {
      untrack(() => {
        const existing = bucket ?? {
          id: "",
          public: false,
          file_size_limit: null,
          allowed_mime_types: null,
        };
        id = existing.id;
        isPublic = existing.public;
        initialLimit = existing.file_size_limit;
        limitMb = initialLimit === null ? "" : String(initialLimit / MB);
        initialLimitMb = limitMb;
        types = existing.allowed_mime_types?.join(", ") ?? "";
        failure = "";
        initialValue = snapshot();
      });
    }
  });

  // Display formatting must never become a mutation of an untouched setting.
  const limit = $derived.by(() => {
    if (limitMb === initialLimitMb) return initialLimit;
    return limitMb.trim() === "" ? null : Math.round(Number(limitMb.replace(",", ".")) * MB);
  });
  const limitOk = $derived(limit === null || (Number.isFinite(limit) && limit > 0));
  const ready = $derived((bucket !== null || validBucketName(id)) && limitOk);
  const nameInvalid = $derived(id !== "" && Boolean(validBucketName(id)) === false);
  // Opening an existing bucket exposes every file already in it: ask first.
  const goingPublic = $derived(bucket !== null && Boolean(bucket.public) === false && isPublic);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving || Boolean(ready) === false) return;
    if (goingPublic) {
      confirmPublicOpen = true;
      return;
    }
    void save();
  }

  async function save() {
    if (saving || Boolean(ready) === false) return;
    saving = true;
    failure = "";
    const settings = {
      public: isPublic,
      file_size_limit: limit,
      allowed_mime_types: parseTypes(types),
    };
    try {
      if (bucket != null) {
        await api.put(`/storage/buckets/${enc(bucket.id)}`, settings);
        toast.success(t("storage.dialog.saved", { bucket: bucket.id }));
        open = false;
        onsaved();
        return;
      }
      await api.post("/storage/buckets", { id, ...settings });
      toast.success(t("storage.dialog.created", { bucket: id }));
      open = false;
      onsaved();
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
          <Dialog.Title>
            {bucket
              ? t("storage.dialog.editTitle", { bucket: bucket.id })
              : t("storage.dialog.createTitle")}
          </Dialog.Title>
        </Dialog.Header>
        <Field.Group class="gap-5">
          {#if !bucket}
            <Field.Field data-invalid={nameInvalid}>
              <Field.Label for="bucket-id">{t("storage.dialog.name")}</Field.Label>
              <Input
                id="bucket-id"
                name="bucket-name"
                bind:value={id}
                placeholder={t("storage.dialog.namePlaceholder")}
                autocomplete="off"
                spellcheck={false}
                class="font-mono"
                aria-invalid={nameInvalid}
                aria-describedby="bucket-id-hint"
                required
              />
              {#if nameInvalid}<Field.Error id="bucket-id-hint"
                  >{t("storage.dialog.nameInvalid")}</Field.Error
                >
              {/if}
              {#if !nameInvalid}<Field.Description id="bucket-id-hint"
                  >{t("storage.dialog.nameHint")}</Field.Description
                >{/if}
            </Field.Field>
          {/if}
          <Field.Field>
            <Field.Field orientation="horizontal">
              <Checkbox
                id="bucket-public"
                bind:checked={isPublic}
                aria-describedby="bucket-public-hint"
              />
              <Field.Label for="bucket-public">{t("storage.dialog.public")}</Field.Label>
            </Field.Field>
            <Field.Description id="bucket-public-hint"
              >{t("storage.dialog.publicHint")}</Field.Description
            >
            {#if !bucket && isPublic}<Callout>{t("storage.dialog.publicWarning")}</Callout>{/if}
          </Field.Field>
          <Field.Field data-invalid={!limitOk}>
            <Field.Label for="bucket-limit">{t("storage.dialog.limit")}</Field.Label>
            <Input
              id="bucket-limit"
              name="file-size-limit"
              bind:value={limitMb}
              inputmode="decimal"
              autocomplete="off"
              class="font-mono"
              aria-invalid={!limitOk}
              aria-describedby="bucket-limit-hint"
            />
            {#if !limitOk}<Field.Error id="bucket-limit-hint"
                >{t("storage.dialog.limitInvalid")}</Field.Error
              >
            {/if}
            {#if !!limitOk}<Field.Description id="bucket-limit-hint">
                {t("storage.dialog.limitHint", { size: formatBytes(serverLimit, intlLocale()) })}
              </Field.Description>{/if}
          </Field.Field>
          <Field.Field>
            <Field.Label for="bucket-types">{t("storage.dialog.types")}</Field.Label>
            <Input
              id="bucket-types"
              name="accepted-types"
              bind:value={types}
              placeholder="image/*"
              autocomplete="off"
              spellcheck={false}
              class="font-mono"
              aria-describedby="bucket-types-hint"
            />
            <Field.Description id="bucket-types-hint"
              >{t("storage.dialog.typesHint")}</Field.Description
            >
          </Field.Field>
        </Field.Group>
        {#if failure}<Field.Error>{failure}</Field.Error>{/if}
        {#if !bucket && !validBucketName(id)}<p
            id="bucket-submit-hint"
            class="text-sm text-muted-foreground"
          >
            {t("storage.dialog.nameRequired")}
          </p>{/if}
        <Dialog.Footer>
          <Button variant="outline" disabled={saving} onclick={guard.request}
            >{t("common.cancel")}</Button
          >
          <Button
            type="submit"
            disabled={saving || !ready}
            aria-describedby={!bucket && !validBucketName(id) ? "bucket-submit-hint" : undefined}
          >
            {#if saving}<LoaderCircle
                data-icon="inline-start"
                class="animate-spin"
                aria-hidden="true"
              />{/if}
            {#if !saving && bucket}<Save data-icon="inline-start" aria-hidden="true" />{/if}
            {#if !saving && !bucket}<HardDrive data-icon="inline-start" aria-hidden="true" />{/if}
            {saving
              ? t("common.saving")
              : bucket
                ? t("storage.dialog.save")
                : t("storage.dialog.create")}
          </Button>
        </Dialog.Footer>
      </fieldset>
    </form>
  </Dialog.Content>
</Dialog.Root>
<UnsavedChangesDialog bind:open={guard.pending} ondiscard={guard.discard} />
{#if bucket}
  <ConfirmDialog
    bind:open={confirmPublicOpen}
    title={t("storage.dialog.confirmPublic.title", { bucket: bucket.id })}
    description={bucket.files
      ? t("storage.dialog.confirmPublic.description", { count: bucket.files })
      : t("storage.dialog.confirmPublic.empty")}
    confirmLabel={t("storage.dialog.confirmPublic.confirm")}
    destructive
    onconfirm={save}
  />
{/if}
