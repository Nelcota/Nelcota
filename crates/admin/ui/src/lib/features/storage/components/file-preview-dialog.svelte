<script lang="ts">
  import { untrack } from "svelte";
  import { Dialog, Button, Skeleton } from "$lib/components/ui";

  import { Download, FileText, ArrowUpRight } from "@lucide/svelte";

  import LoadError from "$lib/components/shared/load-error.svelte";
  import CodeBlock from "$lib/components/shared/code-block.svelte";
  import { ApiError, expireSession, isAbort } from "$lib/transport/api";
  import { baseName, formatBytes, previewKind, PREVIEW_LIMITS } from "$lib/features/storage/files";
  import { readPreview } from "$lib/features/storage/preview";
  import type { StoredFile } from "$lib/contracts/types";
  import { errorMessage, intlLocale, t } from "$lib/i18n/index.svelte";

  let {
    open = $bindable(false),
    file,
    url,
  }: { open?: boolean; file: StoredFile; url: string } = $props();
  let loading = $state(false);
  let error = $state("");
  let media = $state("");
  let text = $state("");
  let unavailable = $state(false);
  let controller: AbortController | undefined;
  let objectUrl = "";
  const kind = $derived(previewKind(file.mime_type, file.size));

  function release() {
    controller?.abort();
    controller = undefined;
    if (objectUrl !== "") URL.revokeObjectURL(objectUrl);
    objectUrl = "";
    media = "";
    text = "";
  }

  function currentPreview(request: AbortController): boolean {
    return controller === request && request.signal.aborted === false;
  }
  async function load() {
    release();
    const request = (controller = new AbortController());
    const target = file;
    const format = kind;
    media = "";
    text = "";
    error = "";
    unavailable = format === null;
    if (format === null) {
      loading = false;
      return;
    }
    loading = true;
    try {
      const response = await fetch(url, { credentials: "same-origin", signal: request.signal });
      if (response.ok === false) {
        expireSession(response.status, url);
        throw new ApiError(t("common.requestFailed"), response.status);
      }
      const blob = await readPreview(
        response,
        format === "text" ? PREVIEW_LIMITS.textBytes : PREVIEW_LIMITS.mediaBytes,
        request.signal,
      );
      if (request.signal.aborted) return;
      if (blob == null) {
        unavailable = true;
        return;
      }
      await displayBlob(blob, { format, request, mime: target.mime_type });
    } catch (e) {
      if (currentPreview(request) && Boolean(isAbort(e)) === false) error = errorMessage(e);
    } finally {
      if (controller === request) loading = false;
    }
  }

  async function displayBlob(
    blob: Blob,
    { format, request, mime }: { format: string; request: AbortController; mime: string },
  ) {
    if (format === "text") {
      const content = await blob.text();
      if (request.signal.aborted === false) text = content;
      return;
    }
    if (format === "pdf") {
      objectUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      media = objectUrl;
      return;
    }
    const reader = new FileReader();
    const result = await new Promise<string>((resolve, reject) => {
      reader.onload = () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("FileReader did not return a data URL"));
      };
      reader.onerror = () =>
        reject(reader.error ?? new Error("FileReader failed to read the preview"));
      reader.readAsDataURL(new Blob([blob], { type: mime }));
    });
    if (request.signal.aborted === false) media = result;
  }

  $effect(() => {
    void [file.id, url];
    if (open) void untrack(load);
    return release;
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-3xl">
    <Dialog.Header>
      <Dialog.Title class="break-all pr-6">{baseName(file.name)}</Dialog.Title>
      <Dialog.Description class="break-all"
        >{[
          ...(file.name.includes("/") ? [file.name] : []),
          file.mime_type,
          formatBytes(file.size, intlLocale()),
        ].join(" · ")}</Dialog.Description
      >
    </Dialog.Header>
    {#if error}<LoadError message={error} onretry={load} busy={loading} />
    {/if}
    {#if !error && loading}<Skeleton class="h-48" />
    {/if}
    {#if !error && !loading && unavailable}<p class="text-sm text-muted-foreground">
        {t("storage.browser.previewUnavailable")}
      </p>
    {/if}
    {#if !error && !loading && !unavailable && kind === "image" && media}<img
        src={media}
        alt={baseName(file.name)}
        class="mx-auto max-h-[60dvh] max-w-full rounded-md object-contain"
        onerror={() => (error = t("common.requestFailed"))}
      />
    {/if}
    {#if !error && !loading && !unavailable && !(kind === "image" && media) && kind === "text"}<CodeBlock
        code={text}
        wrap
      />
    {/if}
    {#if !error && !loading && !unavailable && !(kind === "image" && media) && !(kind === "text") && kind === "pdf" && media}<div
        class="grid justify-items-center gap-3 rounded-lg border bg-muted/30 p-8"
      >
        <FileText class="size-12 text-muted-foreground" aria-hidden="true" />
        <p class="text-sm text-muted-foreground">{t("storage.browser.pdfHint")}</p>
        <Button variant="outline" href={media} target="_blank" rel="noopener"
          >{t("storage.browser.openPdf")}<ArrowUpRight
            data-icon="inline-end"
            aria-hidden="true"
          /></Button
        >
      </div>{/if}
    <Dialog.Footer
      ><Button variant="outline" onclick={() => (open = false)}>{t("common.close")}</Button><Button
        href={url}
        download
        ><Download data-icon="inline-start" aria-hidden="true" />{t("common.download")}</Button
      ></Dialog.Footer
    >
  </Dialog.Content>
</Dialog.Root>
