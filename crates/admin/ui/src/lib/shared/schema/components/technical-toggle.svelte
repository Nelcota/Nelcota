<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import Code from "@lucide/svelte/icons/code";
  import { technical, toggleTechnical } from "$lib/shared/schema/technical.svelte";
  import { t } from "$lib/i18n/index.svelte";
</script>

<Button
  variant={technical.on ? "secondary" : "ghost"}
  size="sm"
  aria-pressed={technical.on}
  title={t("policies.plain.toggleHint")}
  onclick={toggleTechnical}
  ><Code data-icon="inline-start" aria-hidden="true" />{t("policies.plain.toggle")}</Button
>
