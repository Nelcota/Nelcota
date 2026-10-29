<script lang="ts">
  import { Button, Input } from "$lib/components/ui";
  import { CodeBlock } from "$lib/components/shared";
  import { href } from "$lib/navigation/router.svelte";
  import { t } from "$lib/i18n/index.svelte";
  import { deploymentCommands } from "./deployment";
  let environment = $state("production");
  const commands = $derived(deploymentCommands(location.origin, environment));
</script>

<div class="grid gap-3 rounded-2xl border p-4">
  <h3 class="font-semibold">{t("connect.deployment.title")}</h3>
  <p class="text-sm text-muted-foreground">{t("connect.deployment.scope")}</p>
  <dl class="grid gap-2 text-sm sm:grid-cols-2">
    <div>
      <dt class="text-muted-foreground">{t("connect.deployment.target")}</dt>
      <dd class="break-all font-mono" translate="no">{location.origin}</dd>
    </div>
    <div>
      <dt><label for="deployment-environment">{t("connect.deployment.environment")}</label></dt>
      <dd>
        <Input
          id="deployment-environment"
          bind:value={environment}
          maxlength={40}
          pattern="[a-zA-Z0-9_-]+"
        />
      </dd>
    </div>
  </dl>
  <p class="text-sm text-muted-foreground">{t("connect.deployment.environmentHint")}</p>
  <ol class="grid list-inside list-decimal gap-2 text-sm">
    <li>{t("connect.deployment.backup")}</li>
    <li>{t("connect.deployment.credential")}</li>
    <li>{t("connect.deployment.preview")}</li>
    <li>{t("connect.deployment.verify")}</li>
  </ol>
  {#if commands !== null}<CodeBlock code={commands.preview} lang="sh" />
    <details class="rounded-xl border p-3">
      <summary class="cursor-pointer font-medium"
        >{t("connect.deployment.applyAfterReview")}</summary
      >
      <p class="my-3 text-sm">{t("connect.deployment.applyImpact")}</p>
      <CodeBlock code={commands.apply} lang="sh" />
    </details>
    <p class="text-sm">{t("connect.deployment.verify")}</p>
    <CodeBlock code={commands.verify} lang="sh" />{/if}
  {#if commands === null}<p role="alert" class="text-sm text-destructive">
      {t("connect.deployment.invalidEnvironment")}
    </p>{/if}
  <div class="flex flex-wrap gap-2">
    <Button variant="outline" href={href("/migrations")}
      >{t("connect.deployment.migrations")}</Button
    >
    <Button
      variant="ghost"
      href={href("/guides/remote-migrations?section=automatic-backup-before-application")}
      >{t("connect.deployment.backupAction")}</Button
    >
    <Button variant="ghost" href={href("/guides/deploy")}
      >{t("connect.deployment.hostAction")}</Button
    >
  </div>
</div>
