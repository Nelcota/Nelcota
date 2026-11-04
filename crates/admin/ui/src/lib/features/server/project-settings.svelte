<script lang="ts">
  import { untrack } from "svelte";
  import { Button, Input } from "$lib/components/ui";
  import { i18n, intlLocale, translate } from "$lib/i18n/index.svelte";
  import type { Configuration } from "./contracts";
  import EmailPreview from "./email-preview.svelte";
  import type { ProjectSettingKey } from "$lib/generated/contracts";
  import {
    projectChanges,
    settingsDraft,
    type ProjectSettingsView,
    type ProjectSetting,
    type SettingsDraft,
    type SettingValue,
  } from "./project-settings";

  let {
    view,
    project,
    disabled,
    prepare,
    ondirty,
  }: {
    view: ProjectSettingsView | null;
    project: string;
    disabled: boolean;
    prepare: (configuration: Configuration) => Promise<boolean>;
    ondirty: (dirty: boolean) => void;
  } = $props();
  let draft = $state<SettingsDraft>({});
  let failure = $state("");
  const s = (key: string) => translate(i18n.locale, `server.routine.${key}`);
  const blocked = $derived(disabled || canEdit(view) === false);
  const changes = $derived(view === null ? null : projectChanges(view, draft));
  const count = $derived(changes === null ? 0 : Object.keys(changes).length);
  const groups = $derived(
    (["authentication", "email", "api", "storage"] as const).filter(
      (group) => view?.settings.some((setting) => setting.group === group) === true,
    ),
  );
  const formatter = $derived(new Intl.NumberFormat(intlLocale()));
  $effect(() => {
    const snapshot = view;
    untrack(() => {
      draft = snapshot === null ? {} : settingsDraft(snapshot);
      failure = "";
    });
  });

  function canEdit(snapshot: ProjectSettingsView | null): boolean {
    if (snapshot === null) return false;
    if (snapshot.blocked !== null) return false;
    if (snapshot.runtime_status !== "effective") return false;
    return snapshot.settings.every((setting) => setting.pending_restart === false);
  }
  function edit(key: ProjectSettingKey, value: string | boolean | null) {
    draft[key] = value;
    failure = "";
    ondirty(true);
  }
  function display(value: SettingValue, key: ProjectSettingKey): string {
    if (value === null) return s(key === "cors_allow_origins" ? "anyOrigin" : "automatic");
    if (typeof value === "boolean") return s(value ? "yes" : "no");
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.length === 0 ? s("noOrigins") : value.join(", ");
    return formatter.format(value);
  }
  function explicitDraft(setting: ProjectSetting): string {
    if (setting.kind === "text") return String(setting.saved_value ?? setting.expected_value ?? "");
    if (setting.kind === "origins")
      return Array.isArray(setting.saved_value) ? setting.saved_value.join("\n") : "";
    return String(setting.saved_value ?? setting.minimum);
  }
  function textDraft(key: ProjectSettingKey): string {
    const value = draft[key];
    return typeof value === "string" ? value : "";
  }
  function inputBound(setting: ProjectSetting, bound: "minimum" | "maximum"): number {
    // The model permits an unchanged legacy value outside the panel's tighter
    // range. Native form validation must permit it too; changed values still
    // go through projectChanges and the controller's catalog validation.
    const saved = setting.saved_value;
    if (typeof saved !== "number") return setting[bound];
    if (bound === "minimum") return Math.min(setting.minimum, saved);
    return Math.max(setting.maximum, saved);
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (blocked || view === null || changes === null || count === 0) return;
    if (
      await prepare({
        section: "project_settings",
        expected_revision: view.revision,
        values: changes,
      })
    ) {
      ondirty(false);
      return;
    }
    failure = s("notPrepared");
  }
</script>

{#if view === null}<p role="status" class="text-sm text-muted-foreground">
    {s("unsupported")}
  </p>{/if}
{#if view !== null}
  <form class="grid gap-5" onsubmit={submit}>
    <p class="text-sm text-muted-foreground">{s("authority")}</p>
    <p class="rounded-xl border border-border bg-well p-3 text-sm" role="status">
      {s(`runtime.${view.runtime_status}`)}
    </p>
    {#if view.blocked !== null}<p role="alert" class="text-sm text-destructive">
        {s(`blocked.${view.blocked}`)}
      </p>{/if}
    {#if failure !== ""}<p role="alert" class="text-sm text-destructive">{failure}</p>{/if}
    {#each groups as group (group)}
      <fieldset class="grid min-w-0 gap-4" disabled={blocked}>
        <legend class="mb-3 text-lg font-semibold">{s(`groups.${group}`)}</legend>
        {#each view.settings.filter((setting) => setting.group === group) as setting (setting.key)}
          <div class="grid min-w-0 gap-2 rounded-2xl border border-border p-4">
            <label class="flex flex-wrap items-center gap-3" for={`setting-${setting.key}`}>
              <span class="font-medium">{s(`fields.${setting.key}.label`)}</span>
              {#if setting.kind === "boolean"}
                <input
                  id={`setting-${setting.key}`}
                  type="checkbox"
                  checked={draft[setting.key] === true}
                  onchange={(event) => edit(setting.key, event.currentTarget.checked)}
                  aria-describedby={`hint-${setting.key}`}
                />
              {/if}
            </label>
            {#if setting.kind === "integer"}
              <Input
                id={`setting-${setting.key}`}
                type="number"
                min={inputBound(setting, "minimum")}
                max={inputBound(setting, "maximum")}
                step={1}
                required={draft[setting.key] !== null}
                disabled={blocked || draft[setting.key] === null}
                value={textDraft(setting.key)}
                oninput={(event) => edit(setting.key, event.currentTarget.value)}
                aria-describedby={`hint-${setting.key}`}
              />
            {/if}
            {#if setting.kind === "origins"}<textarea
                id={`setting-${setting.key}`}
                class="min-h-28 rounded-xl border border-border bg-background p-3"
                value={textDraft(setting.key)}
                disabled={blocked || draft[setting.key] === null}
                oninput={(event) => edit(setting.key, event.currentTarget.value)}
                aria-describedby={`hint-${setting.key}`}></textarea>{/if}
            {#if setting.kind === "text" && setting.key === "email_language"}
              <select
                id={`setting-${setting.key}`}
                class="rounded-xl border border-border bg-background p-3"
                value={textDraft(setting.key)}
                onchange={(event) => edit(setting.key, event.currentTarget.value)}
                aria-describedby={`hint-${setting.key}`}
              >
                <option value="en">English</option><option value="pt-BR">Português (Brasil)</option>
              </select>
            {/if}
            {#if setting.kind === "text" && setting.key.endsWith("_subject_base64")}
              <Input
                id={`setting-${setting.key}`}
                maxlength={setting.maximum}
                value={textDraft(setting.key)}
                disabled={blocked || draft[setting.key] === null}
                oninput={(event) => edit(setting.key, event.currentTarget.value)}
                aria-describedby={`hint-${setting.key}`}
              />
            {/if}
            {#if setting.kind === "text" && setting.key.endsWith("_text_base64")}
              <textarea
                id={`setting-${setting.key}`}
                class="min-h-20 w-full min-w-0 rounded-xl border border-border bg-background p-3"
                maxlength={setting.maximum}
                value={textDraft(setting.key)}
                disabled={blocked || draft[setting.key] === null}
                oninput={(event) => edit(setting.key, event.currentTarget.value)}
                aria-describedby={`hint-${setting.key}`}></textarea>
            {/if}
            {#if setting.nullable}
              <label class="flex items-center gap-2 text-sm"
                ><input
                  type="checkbox"
                  checked={draft[setting.key] === null}
                  onchange={(event) =>
                    edit(setting.key, event.currentTarget.checked ? null : explicitDraft(setting))}
                />{s("useDefault")}</label
              >
            {/if}
            <p id={`hint-${setting.key}`} class="text-sm text-muted-foreground">
              {s(`fields.${setting.key}.hint`)}
            </p>
            <dl class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt>{s("saved")}</dt>
              <dd class="break-all">{display(setting.saved_value, setting.key)}</dd>
              <dt>{s("source")}</dt>
              <dd>{s(`sources.${setting.source}`)}</dd>
              <dt>{s("default")}</dt>
              <dd class="break-all">{display(setting.default_value, setting.key)}</dd>
              {#if view.runtime_status === "effective"}<dt>{s("runtimeValue")}</dt>
                <dd class="break-all">{display(setting.runtime_value, setting.key)}</dd>{/if}
            </dl>
            {#if setting.pending_restart === true}<p role="status" class="text-sm text-warning">
                {s("pending")}
              </p>{/if}
          </div>
        {/each}
        {#if group === "email" && view.settings.some((setting) => setting.group === "email")}
          <EmailPreview {project} {view} {draft} disabled={blocked} />
        {/if}
      </fieldset>
    {/each}
    <p class="text-sm text-muted-foreground">{s("impact")}</p>
    {#if count > 0}<p role="status" class="text-sm">{s("changed")}: {count}</p>{/if}
    <Button class="w-fit" type="submit" disabled={blocked || changes === null || count === 0}
      >{s("review")}</Button
    >
  </form>
{/if}
