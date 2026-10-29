<script lang="ts">
  import { loadPage, pageFor, crumbsFor, handlePaletteShortcut, palette } from "./model";
  import { tick, type Component } from "svelte";
  import { toast } from "svelte-sonner";
  import { Toaster, Tooltip } from "$lib/components/ui";

  import TopNav from "./components/top-nav.svelte";
  import NotFound from "./not-found.svelte";
  import LoadError from "$lib/components/shared/load-error.svelte";
  import { session } from "$lib/resources/session.svelte";
  import { route } from "$lib/navigation/router.svelte";
  import { errorMessage, t } from "$lib/i18n/index.svelte";

  const page = $derived(pageFor(route.path));
  // Same promise for the same page, so a table's data/structure switch keeps the editor.
  const pageModule = $derived(page === null ? null : loadPage(page.load));
  let content = $state<HTMLElement>();
  let keyboardNavigation = $state(false);
  let previousPath = route.path;
  const pageLabel = $derived(
    crumbsFor(route.path)
      .map((crumb) => crumb.label)
      .join(" · "),
  );

  // The command palette's code (cmdk) loads the first time it opens.
  let CommandPalette = $state<Component | null>(null);
  let paletteRequested = false;
  $effect(() => {
    if (palette.open === false || paletteRequested) return;
    paletteRequested = true;
    import("./components/command-palette.svelte")
      .then((module) => (CommandPalette = module.default))
      .catch((error: unknown) => {
        paletteRequested = false;
        palette.open = false;
        toast.error(errorMessage(error));
      });
  });

  $effect(() => {
    const nextPath = route.path;
    if (nextPath === previousPath) return;
    previousPath = nextPath;
    if (session.email != null && session.email !== "") {
      void tick().then(() => {
        if (route.path === nextPath) content?.focus();
      });
    }
  });
</script>

{#snippet loading()}
  <p
    class="mx-auto w-full max-w-page px-4 pt-2 text-sm text-muted-foreground sm:px-6 lg:px-8"
    role="status"
  >
    {t("shell.app.loading")}
  </p>
{/snippet}
{#snippet failed(error: unknown)}
  <!-- A page whose code could not be fetched (often a new release): the same
       card as any other load failure, and a reload to try again. -->
  <div class="mx-auto w-full max-w-page px-4 pt-2 sm:px-6 lg:px-8">
    <LoadError message={errorMessage(error)} onretry={() => window.location.reload()} />
  </div>
{/snippet}

<svelte:window
  onkeydown={(event) => {
    keyboardNavigation = true;
    handlePaletteShortcut(event);
  }}
  onpointerdown={() => (keyboardNavigation = false)}
/>
<Toaster position="bottom-right" />
<Tooltip.Provider delayDuration={200}>
  <a
    href="#conteudo"
    class="sr-only z-50 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-raised focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
    >{t("shell.app.skipToContent")}</a
  >
  <div class="panel-frame">
    <TopNav>
      <!-- Pointer navigation keeps route focus without framing the viewport. -->
      <!-- Keep absolute accessibility labels inside this scroll container. -->
      <!-- The page is a keyboard scroll target even when it has no controls. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard scrolling of this main region is covered by scrollable-content.spec.ts.) -->
      <main
        bind:this={content}
        id="conteudo"
        tabindex="0"
        aria-label={pageLabel}
        class={`relative min-h-0 min-w-0 flex-1 overflow-auto ${keyboardNavigation ? "focus-visible:-outline-offset-2" : "focus-visible:outline-none"}`}
      >
        {#key page?.key ?? route.path}
          {#if page && pageModule}
            {#await pageModule}
              {@render loading()}
            {:then m}
              {@const Page = m.default as Component<Record<string, unknown>>}
              <Page {...page.props} />
            {:catch error}{@render failed(error)}{/await}
          {:else}<NotFound />{/if}
        {/key}
      </main>
    </TopNav>
  </div>
  {#if CommandPalette}<CommandPalette />{/if}
</Tooltip.Provider>
