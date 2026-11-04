<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { api } from "$lib/transport/api";
  import { errorMessage, t } from "$lib/i18n/index.svelte";
  import { RemoteResource } from "$lib/resources/remote-resource.svelte";
  import type { EmailCapabilities, EmailPreview, EmailTest } from "$lib/generated/contracts";
  import type { ProjectSettingsView, SettingsDraft } from "./project-settings";
  import { emailPreviewRequest, type EmailKind } from "./email-preview";

  let {
    project,
    view,
    draft,
    disabled,
  }: { project: string; view: ProjectSettingsView; draft: SettingsDraft; disabled: boolean } =
    $props();
  let kind = $state<EmailKind>("recovery");
  const capabilities = new RemoteResource<EmailCapabilities>();
  const preview = new RemoteResource<EmailPreview>();
  const test = new RemoteResource<EmailTest>();
  const request = $derived(emailPreviewRequest({ project, kind, view, draft }));
  const identity = $derived(JSON.stringify(request));
  const available = $derived(
    capabilities.data?.configured === true && capabilities.data.project === project,
  );
  const busy = $derived(preview.loading || test.loading);

  $effect(() => {
    void project;
    untrack(() => {
      void capabilities.load((signal) =>
        api.get<EmailCapabilities>("/email", { signal, freshForMs: 0 }),
      );
    });
  });
  $effect(() => {
    void identity;
    untrack(() => {
      preview.clear();
      test.clear();
    });
  });
  onDestroy(() => {
    capabilities.cancel();
    preview.cancel();
    test.cancel();
  });

  async function showPreview() {
    const selected = request;
    if (selected === null || busy || disabled) return;
    await preview.load((signal) => api.post<EmailPreview>("/email/preview", selected, { signal }));
  }
  async function sendTest() {
    const selected = request;
    if (selected === null || busy || disabled || available === false) return;
    await test.load((signal) => api.post<EmailTest>("/email/test", selected, { signal }));
  }
</script>

<section
  class="grid min-w-0 gap-3 rounded-2xl border border-border bg-well p-4"
  aria-busy={busy}
  aria-labelledby="email-preview-title"
>
  <h3 id="email-preview-title" class="font-semibold">{t("server.email.title")}</h3>
  <p class="text-sm text-muted-foreground">{t("server.email.variables")}</p>
  <p class="text-sm text-muted-foreground">{t("server.email.safety")}</p>
  <label class="grid gap-2" for="email-preview-kind"
    ><span>{t("server.email.kind")}</span>
    <select
      id="email-preview-kind"
      class="rounded-xl border border-border bg-background p-3"
      bind:value={kind}
      disabled={disabled || busy}
    >
      <option value="recovery">{t("server.email.recovery")}</option><option value="signup"
        >{t("server.email.signup")}</option
      ><option value="magiclink">{t("server.email.magiclink")}</option>
    </select>
  </label>
  <div class="flex flex-wrap gap-2">
    <Button
      type="button"
      variant="outline"
      disabled={disabled || busy || request === null}
      onclick={showPreview}>{t("server.email.preview")}</Button
    >
    <Button
      type="button"
      variant="outline"
      disabled={disabled || busy || request === null || available === false}
      onclick={sendTest}>{t("server.email.sendTest")}</Button
    >
  </div>
  {#if capabilities.data !== null}<p class="text-sm">
      {t("server.email.recipient")}: {capabilities.data.test_recipient}
    </p>{/if}
  {#if available === false}<p class="text-sm text-muted-foreground">
      {t("server.email.unavailable")}
    </p>{/if}
  {#if capabilities.error !== null}<p role="alert" class="text-sm text-destructive">
      {errorMessage(capabilities.error)}
    </p>{/if}
  {#if preview.error !== null}<p role="alert" class="text-sm text-destructive">
      {errorMessage(preview.error)}
    </p>{/if}
  {#if test.error !== null}<p role="alert" class="text-sm text-destructive">
      {errorMessage(test.error)}
    </p>{/if}
  {#if test.data?.accepted === true}<p role="status" class="text-sm">
      {t("server.email.accepted")}
    </p>{/if}
  {#if preview.data !== null}
    <div
      class="grid gap-2 rounded-xl border border-border bg-background p-3"
      aria-label={t("server.email.result")}
    >
      <p class="break-words font-medium">{preview.data.subject}</p>
      <pre class="min-w-0 whitespace-pre-wrap break-all text-sm">{preview.data.text}</pre>
    </div>
  {/if}
</section>
