<script lang="ts">
  import { i18n, intlLocale, translate } from "$lib/i18n/index.svelte";
  import type { SettingChange, SettingValue } from "../../server/project-settings";
  import type { ProjectSettingKey } from "$lib/generated/contracts";
  let { changes }: { changes: SettingChange[] } = $props();
  const s = (key: string) => translate(i18n.locale, `server.routine.${key}`);
  const formatter = $derived(new Intl.NumberFormat(intlLocale()));
  function display(value: SettingValue, key: ProjectSettingKey) {
    if (value === null) return s(key === "cors_allow_origins" ? "anyOrigin" : "automatic");
    if (typeof value === "boolean") return s(value ? "yes" : "no");
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.length === 0 ? s("noOrigins") : value.join(", ");
    return formatter.format(value);
  }
</script>

<section class="grid gap-3" aria-labelledby="configuration-changes-title">
  <h4 id="configuration-changes-title" class="font-semibold">{s("reviewedChanges")}</h4>
  <ul class="grid gap-2">
    {#each changes as change (change.key)}
      <li class="rounded-xl bg-well p-3 text-sm">
        <span class="font-medium">{s(`fields.${change.key}.label`)}</span>
        <p class="whitespace-pre-wrap break-all">
          {s("runtimeValue")}: {display(change.before, change.key)} → {s("proposed")}: {display(
            change.after,
            change.key,
          )}
        </p>
      </li>
    {/each}
  </ul>
  <p class="text-sm text-muted-foreground">{s("impact")}</p>
</section>
