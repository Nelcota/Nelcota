<script lang="ts">
  import { onMount } from "svelte";
  import { Button, DropdownMenu, Skeleton } from "$lib/components/ui";

  import { Plus, Trash as Trash2 } from "@lucide/svelte";

  import { toast } from "svelte-sonner";
  import { Callout, ConfirmDialog, LoadError } from "$lib/components/shared";

  import { BucketPolicies, type StoragePolicy } from "../bucket-policies.svelte";
  import { technical } from "$lib/shared/schema/technical.svelte";
  import {
    TEMPLATES,
    describeRule,
    locked,
    type TemplateId,
  } from "$lib/features/storage/bucket-access";
  import { errorMessage, t } from "$lib/i18n/index.svelte";

  let { bucket }: { bucket: string } = $props();

  const resource = new BucketPolicies();
  const access = $derived(resource.data);
  let adding = $state<TemplateId | null>(null);
  let removing = $state<StoragePolicy | null>(null);
  let addOpen = $state(false);
  let removeOpen = $state(false);

  async function load() {
    await resource.reload(bucket);
  }
  onMount(() => {
    void load();
    return () => resource.cancel();
  });

  async function add() {
    if (Boolean(adding) === false) return;
    try {
      await resource.add(bucket, adding);
      toast.success(t("storage.access.added"));
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  }

  async function remove() {
    if (removing == null) return;
    try {
      await resource.remove(bucket, removing.name);
      toast.success(t("storage.access.removed"));
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  }

  const sentence = (policy: StoragePolicy) => {
    const meaning = describeRule(policy, bucket);
    return meaning.kind === "custom"
      ? t("storage.access.custom")
      : t(`storage.access.templates.${meaning.kind}.label`);
  };
</script>

<section class="mb-6 grid gap-3 rounded-3xl bg-card p-4" aria-labelledby="bucket-access">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div class="grid gap-0.5">
      <h2 id="bucket-access" class="text-base font-semibold">{t("storage.access.title")}</h2>
      <p class="text-sm text-muted-foreground">{t("storage.access.hint")}</p>
      {#if technical.on}<p class="text-sm text-muted-foreground">
          {t("storage.access.technicalHint")}
        </p>{/if}
    </div>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button variant="outline" size="sm" {...props} disabled={!access}
            ><Plus data-icon="inline-start" aria-hidden="true" />{t("storage.access.add")}</Button
          >
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="w-80">
        <DropdownMenu.Group>
          {#each TEMPLATES as template (template)}
            <DropdownMenu.Item
              class="items-start"
              onclick={() => {
                adding = template;
                addOpen = true;
              }}
            >
              <span class="grid gap-0.5">
                <span>{t(`storage.access.templates.${template}.label`)}</span>
                <span class="text-[0.8125rem] text-muted-foreground"
                  >{t(`storage.access.templates.${template}.hint`)}</span
                >
              </span>
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  {#if resource.error}
    <LoadError message={errorMessage(resource.error)} onretry={load} busy={resource.loading} />
  {/if}
  {#if !resource.error && !access}
    <Skeleton class="h-12" />
  {/if}
  {#if !resource.error && !!access}
    {#if locked(access.policies, access.public)}
      <Callout>{t("storage.access.locked")}</Callout>
    {/if}
    {#if !locked(access.policies, access.public) && access.public}
      <p class="rounded-2xl bg-well px-3 py-2.5 text-sm text-muted-foreground">
        {t("storage.access.publicNote")}
      </p>
    {/if}
    {#if access.policies.length}
      <ul class="divide-y overflow-hidden rounded-2xl bg-well">
        {#each access.policies as policy (policy.name)}
          <li class="flex items-start gap-3 px-3 py-2.5">
            <div class="grid min-w-0 flex-1 gap-1">
              <p class="text-sm">{sentence(policy)}</p>
              {#if policy.all_buckets}<p class="text-xs text-muted-foreground">
                  {t("storage.access.allBuckets")}
                </p>{/if}
              {#if technical.on || describeRule(policy, bucket).kind === "custom"}
                <p class="font-mono text-xs break-words text-muted-foreground">
                  {policy.name} · {policy.command} · {policy.roles.join(", ")}{#if policy.using}
                    · USING {policy.using}{/if}{#if policy.check}
                    · WITH CHECK {policy.check}{/if}
                </p>
              {/if}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("storage.access.removeNamed", { rule: sentence(policy) })}
              title={t("storage.access.remove")}
              onclick={() => {
                removing = policy;
                removeOpen = true;
              }}
            >
              <Trash2 />
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<ConfirmDialog
  bind:open={addOpen}
  title={t("storage.access.addTitle")}
  description={adding
    ? `${t(`storage.access.templates.${adding}.label`)}. ${t("storage.access.addText")}`
    : ""}
  confirmLabel={t("storage.access.add")}
  onconfirm={add}
/>
<ConfirmDialog
  bind:open={removeOpen}
  title={t("storage.access.removeTitle")}
  description={removing ? `${sentence(removing)}. ${t("storage.access.removeText")}` : ""}
  confirmLabel={t("storage.access.remove")}
  destructive
  onconfirm={remove}
/>
