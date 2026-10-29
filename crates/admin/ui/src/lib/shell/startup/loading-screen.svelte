<script lang="ts" module>
  type BootStage = "session" | "panel";
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Circle from "@lucide/svelte/icons/circle";
  import Logo from "../components/logo.svelte";
  import { t } from "$lib/i18n/index.svelte";

  // `session`: asking the server who is signed in. `panel`: fetching the
  // signed-in panel's code. Shown as steps, so a wait reads as progress.
  let { stage = "session" }: { stage?: BootStage } = $props();

  const STAGES: BootStage[] = ["session", "panel"];
  const SLOW_AFTER_MS = 8000;

  const current = $derived(STAGES.indexOf(stage));

  // A long wait gets a word on why, instead of an endless spinner.
  let slow = $state(false);
  onMount(() => {
    const timer = setTimeout(() => (slow = true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  });
</script>

<!-- aria-busy sits on the step list, not on <main>: screen readers hold back
     live-region updates inside a busy element, and the step changes below
     must be announced. -->
<main class="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
  <!-- Fades in only after a short wait, so a fast start does not flash it. -->
  <div class="loading-screen-indicator flex w-full max-w-sm flex-col items-center text-center">
    <div class="relative grid size-28 place-items-center" aria-hidden="true">
      <svg class="absolute inset-0 size-full" viewBox="0 0 112 112" fill="none">
        <circle cx="56" cy="56" r="52" stroke-width="4" class="stroke-border" />
        <circle
          cx="56"
          cy="56"
          r="52"
          stroke-width="4"
          stroke-linecap="round"
          pathLength="100"
          stroke-dasharray="22 78"
          class="loading-screen-arc stroke-brand"
        />
      </svg>
      <!-- The brand at the centre of the ring; the steps below say what is happening. -->
      <span class="loading-screen-halo grid size-20 place-items-center rounded-full bg-brand-soft"
        ><Logo mark size="lg" /></span
      >
    </div>

    <div class="mt-7 grid min-h-16 gap-1.5" role="status" aria-live="polite" aria-atomic="true">
      {#key stage}
        <div class="loading-screen-swap grid gap-1.5">
          <!-- Padded on the left by the dots' width, so the words stay centred. -->
          <h1 class="ps-[1.2em] text-xl font-semibold tracking-tight sm:text-2xl">
            {t(`shell.app.boot.${stage}`)}<span class="loading-screen-ellipsis" aria-hidden="true"
            ></span>
          </h1>
          <p class="text-sm text-muted-foreground">{t(`shell.app.boot.${stage}Detail`)}</p>
        </div>
      {/key}
    </div>

    <ol
      class="mt-7 grid w-full gap-1 rounded-2xl bg-card p-2 text-start"
      aria-label={t("shell.app.boot.steps")}
      aria-busy="true"
    >
      {#each STAGES as step, index (step)}
        {@const status = index < current ? "done" : index === current ? "current" : "pending"}
        <li
          class={[
            "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors duration-300",
            status === "current" && "bg-well font-medium",
            status === "pending" && "text-muted-foreground",
          ]}
        >
          {#if status === "done"}<CircleCheck
              class="loading-screen-pop size-[18px] shrink-0 text-brand"
              aria-hidden="true"
            />{/if}
          {#if status === "current"}<LoaderCircle
              class="size-[18px] shrink-0 text-brand motion-safe:animate-spin"
              aria-hidden="true"
            />{/if}
          {#if status === "pending"}<Circle
              class="size-[18px] shrink-0 opacity-50"
              aria-hidden="true"
            />{/if}
          <span class="flex-1">{t(`shell.app.boot.${step}`)}</span>
          <span class="sr-only">({t(`shell.app.boot.${status}`)})</span>
        </li>
      {/each}
    </ol>

    <!-- Always in the page, so the note is announced when it fills in (a live
         region added together with its text is often not read). -->
    <div role="status">
      {#if slow}<p class="loading-screen-swap mt-5 text-sm text-muted-foreground">
          {t("shell.app.boot.slow")}
        </p>{/if}
    </div>
  </div>
</main>
