<script lang="ts">
  import { Button, Input } from "$lib/components/ui";
  import { i18n, translate } from "$lib/i18n/index.svelte";
  import { hostText as h, serverText, label } from "../model";
  import type { HostConsoleState } from "../console-state.svelte";
  let { model }: { model: HostConsoleState } = $props();
</script>

{#if model.target}<form
    bind:this={model.reviewForm}
    onsubmit={model.approve}
    class={`grid gap-5 rounded-3xl border-2 bg-card p-6 ${model.target.kind === "remove" || model.target.kind === "restore" ? "border-destructive/40" : "border-primary/30"}`}
    aria-busy={model.busy}
  >
    <h3 tabindex="-1" class="text-xl font-semibold focus:outline-none">
      {model.recovery ? h("resume") : h("review")}
    </h3>
    <div class="rounded-2xl bg-well p-4">
      <p class="text-sm font-medium text-muted-foreground">
        1 · {h("select")}
      </p>
      <p class="mt-2 text-lg font-semibold" translate="no">
        {model.target.project}
      </p>
      {#if (model.plan?.affected_projects ?? model.recovery?.affected_projects)?.length}<p
          class="mt-2 text-sm"
        >
          {serverText("affected")}:
          <span translate="no"
            >{(model.plan?.affected_projects ?? model.recovery?.affected_projects ?? []).join(
              ", ",
            )}</span
          >
        </p>{/if}
      {#if model.target.kind === "create"}<p translate="no">
          {model.target.domain} · {model.target.profile}
        </p>{/if}{#if model.target.kind === "configure"}<p>{serverText(model.target.section)}</p>
        <p class="text-sm">{serverText("impact")}</p>{/if}{#if model.target.kind === "restart"}<p
          class="text-sm"
        >
          {serverText("restartImpact")}
        </p>{/if}{#if model.target.kind === "backup_offsite"}<p class="text-sm">
          {serverText("offsiteImpact")}
        </p>{/if}{#if model.target.kind === "test_smtp"}<p class="text-sm">
          {serverText("testImpact")}
        </p>{/if}{#if model.target.kind === "restore"}<p class="break-all text-sm" translate="no">
          {model.target.backup}
        </p>{/if}
    </div>
    <div class="grid gap-2 rounded-2xl bg-well p-4">
      <p class="text-sm font-medium text-muted-foreground">
        2 · {h("acknowledge")}
      </p>
      {#if model.target.kind === "create"}<p class="text-sm">
          {h("isolation")}
        </p>
        <p class="text-sm">
          {h("imagePending")}
        </p>{/if}{#if model.target.kind === "backup"}<p class="text-sm">
          {h("backupImpact")}
        </p>{/if}{#if model.target.kind === "remove"}<p class="text-sm">
          {h("destructive")}
          {h("removeImpact")}
        </p>{/if}{#if model.target.kind === "restore" && model.recovery?.last_stage !== "verifying"}<p
          class="text-sm"
        >
          {h("destructive")}
          {h("restoreImpact")}
        </p>{/if}{#if model.recovery}<p class="text-sm">
          {model.target.kind === "configure"
            ? serverText("configurationRecovery")
            : model.target.kind === "restore" && model.recovery.last_stage === "verifying"
              ? h("preserveWrites")
              : h("recovery")}
        </p>{/if}{#if model.plan}<p class="text-sm">
          {h("version")}: <strong translate="no">{model.plan.version}</strong>
        </p>
        <p class="break-all text-[0.8125rem]">
          {h("image")}:
          <span translate="no">sha256:{model.plan.image_digest}</span>
        </p>
        <p class="text-sm">
          {h("remaining")}: {translate(i18n.locale, "host.secondsLeft", { count: model.seconds })}
        </p>{/if}
    </div>
    {#if model.plan && model.plan.blockers.length}<div
        role="alert"
        class="rounded-2xl bg-destructive/5 p-4"
      >
        <p class="font-medium">{h("blocked")}</p>
        <ul class="mt-2 list-inside list-disc text-sm">
          {#each model.plan.blockers as code}<li>{label(code)}</li>{/each}
        </ul>
      </div>{/if}
    {#if model.plan && model.seconds === 0}<p role="alert">
        {h("planExpired")}
      </p>{/if}{#if model.pending && !model.plan}<p role="status">
        {h("pending")} — {h("uncertain")}
      </p>{/if}
    <fieldset
      class="grid gap-4"
      disabled={model.busy ||
        model.offline ||
        (model.plan !== null && (model.plan.blockers.length > 0 || model.seconds === 0))}
    >
      <legend class="mb-3 text-sm font-medium text-muted-foreground">3 · {h("approve")}</legend
      ><label class="flex items-start gap-3 text-sm"
        ><input type="checkbox" required bind:checked={model.acknowledged} class="mt-1" />{h(
          "acknowledge",
        )}</label
      ><label class="flex items-start gap-3 text-sm"
        ><input type="checkbox" required bind:checked={model.rescue} class="mt-1" />{h(
          "rescue",
        )}</label
      ><label for="host-confirmation">{h("typed")}</label><code
        id="host-confirmation-phrase"
        class="w-fit rounded-lg bg-well px-3 py-2"
        translate="no">{model.phrase}</code
      ><Input
        id="host-confirmation"
        aria-describedby="host-confirmation-phrase"
        required
        maxlength={100}
        autocomplete="off"
        bind:value={model.confirmation}
      /><label for="host-password">{h("password")}</label><Input
        id="host-password"
        required
        type="password"
        maxlength={1024}
        autocomplete="current-password"
        bind:value={model.password}
      /><Button class="w-fit" type="submit" disabled={!model.canApprove}
        >{model.busy ? h("busy") : h("approve")}</Button
      >
    </fieldset>
    {#if !model.pending}<Button
        class="w-fit"
        type="button"
        variant="outline"
        disabled={model.busy}
        onclick={model.reset}>{h("cancel")}</Button
      >{/if}
  </form>{/if}
