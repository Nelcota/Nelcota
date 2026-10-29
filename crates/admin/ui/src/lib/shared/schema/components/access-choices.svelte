<script lang="ts">
  import * as Field from "$lib/components/ui/field";
  import * as Select from "$lib/components/ui/select";
  import type { AccessLevel, Audience } from "../guided-access";
  import { t } from "$lib/i18n/index.svelte";
  let {
    audience = $bindable<Audience>("private"),
    level = $bindable<AccessLevel>("read"),
    allowPrivate = false,
    part = "both",
  }: {
    audience?: Audience;
    level?: AccessLevel;
    allowPrivate?: boolean;
    part?: "who" | "action" | "both";
  } = $props();
  const id = $props.id();
  const audiences = $derived<Audience[]>(
    allowPrivate ? ["private", "owner", "signedIn", "everyone"] : ["owner", "signedIn", "everyone"],
  );
</script>

<Field.Group>
  {#if part !== "action"}<Field.Field>
      <Field.Label for={`${id}-audience`}>{t("guided.access.who")}</Field.Label>
      <Select.Root type="single" bind:value={audience}>
        <Select.Trigger id={`${id}-audience`} class="w-full"
          ><span class="truncate">{t(`guided.access.audiences.${audience}.label`)}</span
          ></Select.Trigger
        >
        <Select.Content
          ><Select.Group>
            {#each audiences as option}<Select.Item
                value={option}
                label={t(`guided.access.audiences.${option}.label`)}
                >{t(`guided.access.audiences.${option}.label`)}</Select.Item
              >{/each}
          </Select.Group></Select.Content
        >
      </Select.Root>
      <Field.Description>{t(`guided.access.audiences.${audience}.hint`)}</Field.Description>
    </Field.Field>{/if}
  {#if audience !== "private" && part !== "who"}
    <Field.Field>
      <Field.Label for={`${id}-level`}>{t("guided.access.what")}</Field.Label>
      <Select.Root
        type="single"
        value={audience === "everyone" ? "read" : level}
        onValueChange={(value) => {
          level = value as AccessLevel;
        }}
      >
        <Select.Trigger id={`${id}-level`} class="w-full"
          ><span class="truncate"
            >{t(`guided.access.levels.${audience === "everyone" ? "read" : level}`)}</span
          ></Select.Trigger
        >
        <Select.Content
          ><Select.Group>
            <Select.Item value="read">{t("guided.access.levels.read")}</Select.Item>
            <Select.Item value="full" disabled={audience === "everyone"}
              >{t("guided.access.levels.full")}</Select.Item
            >
          </Select.Group></Select.Content
        >
      </Select.Root>
      {#if audience === "everyone"}<Field.Description
          >{t("guided.access.publicReadOnly")}</Field.Description
        >{/if}
    </Field.Field>
  {/if}
</Field.Group>
