<script lang="ts">
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Globe from "@lucide/svelte/icons/globe";
  import UserRound from "@lucide/svelte/icons/user-round";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Check from "@lucide/svelte/icons/check";
  import UserPickerDialog from "../dialogs/user-picker-dialog.svelte";
  import type { RunAsLabels, Viewer } from "$lib/shared/run-as";

  // Who a read acts as. `warnOwner` makes the owner state amber, where full
  // access is the one to be careful with (the SQL editor, D55); elsewhere it
  // is the normal state and stays neutral.
  let {
    viewer,
    labels,
    warnOwner = false,
    onchange,
  }: {
    viewer: Viewer;
    labels: RunAsLabels;
    warnOwner?: boolean;
    onchange: (viewer: Viewer) => void;
  } = $props();

  let picking = $state(false);
  const owner = $derived(viewer.mode === "owner");
  const current = $derived.by(() => {
    if (owner) return labels.owner;
    return viewer.mode === "anon" ? labels.anon : (viewer.user?.email ?? "");
  });
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class={[
          "inline-flex h-9 max-w-64 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-3.5 text-[0.8125rem] font-medium transition-colors",
          owner && warnOwner
            ? "border-warning/30 bg-warning/10 text-warning hover:bg-warning/15"
            : owner
              ? "border-border bg-field text-muted-foreground hover:bg-accent hover:text-foreground"
              : "border-border-strong bg-muted text-foreground hover:bg-accent",
        ]}
        title={owner ? (labels.ownerTriggerTitle ?? labels.label) : labels.label}
        aria-label={`${labels.label}: ${current}`}
      >
        {#if owner}
          <ShieldAlert
            class="size-3.5 shrink-0"
            aria-hidden="true"
          />{labels.ownerTrigger}{#if labels.ownerTriggerMore}<span class="hidden 2xl:inline"
              >{labels.ownerTriggerMore}</span
            >{/if}
        {/if}
        {#if !owner && viewer.mode === "anon"}
          <Globe class="size-3.5 shrink-0" aria-hidden="true" />{labels.asVisitor}
        {/if}
        {#if !owner && !(viewer.mode === "anon")}
          <UserRound class="size-3.5 shrink-0" aria-hidden="true" /><span class="truncate"
            >{labels.asUser(viewer.user?.email ?? "")}</span
          >
        {/if}
        <ChevronDown class="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="start" class="w-80">
    <DropdownMenu.Label class="text-xs text-muted-foreground">{labels.label}</DropdownMenu.Label>
    <DropdownMenu.Item class="items-start" onclick={() => onchange({ mode: "owner", user: null })}>
      <ShieldAlert class="mt-0.5" aria-hidden="true" />
      <span class="grid flex-1 gap-0.5"
        ><span>{labels.owner}</span><span class="text-xs text-muted-foreground"
          >{labels.ownerHint}</span
        ></span
      >
      {#if owner}<Check class="mt-0.5" aria-hidden="true" />{/if}
    </DropdownMenu.Item>
    <DropdownMenu.Item class="items-start" onclick={() => onchange({ mode: "anon", user: null })}>
      <Globe class="mt-0.5" aria-hidden="true" />
      <span class="grid flex-1 gap-0.5"
        ><span>{labels.anon}</span><span class="text-xs text-muted-foreground"
          >{labels.anonHint}</span
        ></span
      >
      {#if viewer.mode === "anon"}<Check class="mt-0.5" aria-hidden="true" />{/if}
    </DropdownMenu.Item>
    <DropdownMenu.Item class="items-start" onclick={() => (picking = true)}>
      <UserRound class="mt-0.5" aria-hidden="true" />
      <span class="grid min-w-0 flex-1 gap-0.5">
        <span>{labels.authenticated}</span>
        <span class="truncate text-xs text-muted-foreground"
          >{viewer.user ? viewer.user.email : labels.authenticatedHint}</span
        >
      </span>
      {#if viewer.mode === "authenticated"}<Check class="mt-0.5" aria-hidden="true" />{/if}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<UserPickerDialog
  bind:open={picking}
  {labels}
  onpick={(user) => onchange({ mode: "authenticated", user })}
/>
