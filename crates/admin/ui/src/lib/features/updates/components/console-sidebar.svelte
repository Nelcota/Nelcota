<script lang="ts">
  import { Server, Download, Layers } from "@lucide/svelte";
  import SidebarGroup from "$lib/components/shared/sidebar-group.svelte";
  import { hostAreas, type HostArea } from "../../host/navigation";
  import { t } from "$lib/i18n/index.svelte";
  import type { UpdatesConsoleState } from "../console-state.svelte";
  import type { Status } from "../controller";
  let {
    model,
    status,
    view,
    hostArea,
    navigationBusy,
    onarea,
    onupdates,
  }: {
    model: UpdatesConsoleState;
    status: Status;
    view: "projects" | "updates";
    hostArea: HostArea;
    navigationBusy: () => boolean;
    onarea: (area: HostArea) => void;
    onupdates: () => void;
  } = $props();
</script>

<aside class="console-sidebar">
  <div class="sidebar-context">
    <span class="context-icon"><Server class="size-4" aria-hidden="true" /></span>
    <div>
      <span class="eyebrow"
        >{t(
          model.selected && (!status.host_management || view === "updates")
            ? "updates.project"
            : "updates.console",
        )}</span
      >
      <p translate="no">
        {model.selected && (!status.host_management || view === "updates")
          ? model.selected.name
          : t("updates.controller")}
      </p>
    </div>
  </div>
  <nav class="console-nav" aria-label={t("updates.controller")}>
    {#if status.host_management}
      <SidebarGroup label={t("server.title")} icon={Layers} active={view === "projects"}>
        {#each hostAreas as item (item.id)}
          <button
            type="button"
            class="panel-nav-link panel-nav-child w-full text-left"
            class:is-active={view === "projects" && hostArea === item.id}
            aria-current={view === "projects" && hostArea === item.id ? "page" : undefined}
            disabled={model.busy || navigationBusy()}
            onclick={() => onarea(item.id)}
            ><item.icon class="size-4 shrink-0" aria-hidden="true" />{t(
              `server.${item.id}`,
            )}</button
          >
        {/each}
      </SidebarGroup>
    {/if}
    <button
      type="button"
      class="panel-nav-link"
      class:is-active={!status.host_management || view === "updates"}
      aria-current={!status.host_management || view === "updates" ? "page" : undefined}
      onclick={onupdates}><Download class="size-4" aria-hidden="true" />{t("host.updates")}</button
    >
  </nav>
  <div class="operator-card">
    <span class="operator-avatar" aria-hidden="true">{status.email.slice(0, 1).toUpperCase()}</span>
    <div>
      <span class="eyebrow">{t("updates.operator")}</span>
      <p class="operator-email" title={status.email}>{status.email}</p>
    </div>
  </div>
</aside>

<style>
  .console-sidebar {
    position: sticky;
    top: 4.5rem;
    height: calc(100dvh - 4.5rem);
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 1.5rem 0.75rem 0.75rem;
    border-right: 1px solid var(--border);
  }
  .sidebar-context {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.75rem 1.5rem;
    min-width: 0;
  }
  .sidebar-context > div {
    min-width: 0;
  }
  .sidebar-context p {
    font-size: 0.875rem;
    font-weight: 600;
    margin-top: 0.25rem;
    overflow-wrap: anywhere;
  }
  .context-icon {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 0.5rem;
    background: var(--well);
    color: var(--muted-foreground);
  }
  .console-nav {
    display: grid;
    gap: 0.25rem;
  }
  .console-nav button {
    width: 100%;
    text-align: left;
    cursor: pointer;
  }
  .console-nav button :global(svg) {
    flex-shrink: 0;
    stroke-width: 1.6;
  }
  .operator-card {
    margin-top: auto;
    padding: 1.5rem 0.75rem 0.25rem;
    display: flex;
    gap: 0.625rem;
    align-items: center;
    min-width: 0;
  }
  .operator-card > div {
    min-width: 0;
  }
  .operator-avatar {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 0.5rem;
    background: var(--accent);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .operator-email {
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
    margin-top: 0.2rem;
  }
  .eyebrow {
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted-foreground);
    font-weight: 600;
  }
  @media (max-width: 800px) {
    .console-sidebar {
      position: static;
      height: auto;
      overflow: visible;
      padding: 0.75rem 1rem;
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-context,
    .operator-card {
      display: none;
    }
    .console-nav {
      display: flex;
      flex-wrap: wrap;
    }
    .console-nav button {
      width: auto;
      padding: 0.625rem 0.875rem;
    }
  }
</style>
