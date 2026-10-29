<script lang="ts">
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import ZoomIn from "@lucide/svelte/icons/zoom-in";
  import ZoomOut from "@lucide/svelte/icons/zoom-out";
  import { Button } from "$lib/components/ui/button";
  import {
    cropGeometry,
    DEFAULT_CROP,
    drawAvatar,
    moveCrop,
    rotateCrop,
    type AvatarSource,
  } from "../avatar";
  import type { AvatarCrop } from "$lib/contracts/types";
  import { t } from "$lib/i18n/index.svelte";
  const FAST_CROP_STEP = 0.1;
  const CROP_STEP = 0.025;

  let {
    source,
    crop = $bindable(),
    disabled = false,
  }: { source: AvatarSource; crop: AvatarCrop; disabled?: boolean } = $props();
  let surface = $state<HTMLCanvasElement>();
  let small = $state<HTMLCanvasElement>();
  let medium = $state<HTMLCanvasElement>();
  let large = $state<HTMLCanvasElement>();
  let moving = $state(false);
  const hint = $props.id();
  const zoomId = `${hint}-zoom`;
  const points = new Map<number, { x: number; y: number }>();

  $effect(() => {
    for (const canvas of [surface, small, medium, large]) {
      if (canvas != null) drawAvatar(canvas, source, crop);
    }
  });

  function zoom(value: number) {
    crop = cropGeometry(source.width, source.height, { ...crop, zoom: value }).crop;
  }

  function gesture() {
    const values = [...points.values()];
    const first = values[0];
    if (first === undefined) return null;
    const second = values[1];
    if (second === undefined) return { x: first.x, y: first.y, distance: 0 };
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
      distance: Math.hypot(first.x - second.x, first.y - second.y),
    };
  }

  function start(event: PointerEvent) {
    if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (event.currentTarget instanceof HTMLElement)
      event.currentTarget.setPointerCapture(event.pointerId);
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    moving = true;
  }

  function move(event: PointerEvent) {
    if (disabled || points.has(event.pointerId) === false) return;
    const before = gesture();
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = gesture();
    if (before == null || after == null || surface == null) return;
    if (before.distance > 0 && after.distance > 0)
      zoom((crop.zoom * after.distance) / before.distance);
    const size = surface.getBoundingClientRect().width;
    if (size > 0)
      crop = moveCrop(source, crop, {
        dx: (after.x - before.x) / size,
        dy: (after.y - before.y) / size,
      });
  }

  function end(event: PointerEvent) {
    points.delete(event.pointerId);
    moving = points.size > 0;
  }

  function onKey(event: KeyboardEvent) {
    if (disabled) return;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    const step = event.shiftKey ? FAST_CROP_STEP : CROP_STEP;
    crop = moveCrop(source, crop, { dx: direction[0] * step, dy: direction[1] * step });
  }
</script>

<div class="grid min-w-0 gap-5 sm:grid-cols-[minmax(0,1fr)_7rem] sm:items-center">
  <div class="grid min-w-0 gap-3">
    <button
      type="button"
      {disabled}
      aria-label={t("profile.framing")}
      aria-describedby={hint}
      class={[
        "relative mx-auto block aspect-square w-full max-w-80 touch-none overflow-hidden rounded-2xl bg-well outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring",
        moving ? "cursor-grabbing" : "cursor-grab",
      ]}
      onpointerdown={start}
      onpointermove={move}
      onpointerup={end}
      onpointercancel={end}
      onlostpointercapture={end}
      onkeydown={onKey}
      onclick={(event) => {
        if (event.detail === 0)
          crop = cropGeometry(source.width, source.height, { ...crop, x: 0.5, y: 0.5 }).crop;
      }}
    >
      <canvas
        bind:this={surface}
        width="512"
        height="512"
        class="block size-full"
        aria-hidden="true"
      ></canvas>
      <span class="crop-mask pointer-events-none absolute inset-0" aria-hidden="true"></span>
      <span
        class="pointer-events-none absolute inset-0 rounded-full border border-white/80 shadow-sm"
        aria-hidden="true"
      ></span>
    </button>
    <p id={hint} class="text-center text-xs leading-relaxed text-muted-foreground">
      {t("profile.dragHint")}
    </p>
  </div>
  <div
    class="flex items-center justify-center gap-5 sm:flex-col sm:gap-4"
    role="group"
    aria-label={t("profile.preview")}
  >
    <span class="text-xs font-medium text-muted-foreground sm:order-last"
      >{t("profile.preview")}</span
    >
    <span
      class="size-16 overflow-hidden rounded-full bg-primary ring-1 ring-border"
      role="img"
      aria-label={t("profile.previewLarge")}
      ><canvas bind:this={large} width="128" height="128" class="block size-full" aria-hidden="true"
      ></canvas></span
    >
    <span
      class="size-8 overflow-hidden rounded-full bg-primary ring-1 ring-border"
      role="img"
      aria-label={t("profile.previewMenu")}
      ><canvas bind:this={medium} width="64" height="64" class="block size-full" aria-hidden="true"
      ></canvas></span
    >
    <span
      class="size-6 overflow-hidden rounded-full bg-primary ring-1 ring-border"
      role="img"
      aria-label={t("profile.previewSmall")}
      ><canvas bind:this={small} width="48" height="48" class="block size-full" aria-hidden="true"
      ></canvas></span
    >
  </div>
</div>

<div class="grid gap-4">
  <div class="flex items-center gap-3">
    <ZoomOut class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <label for={zoomId} class="sr-only">{t("profile.zoom")}</label>
    <input
      id={zoomId}
      type="range"
      min="1"
      max="4"
      step="0.01"
      value={crop.zoom}
      {disabled}
      oninput={(event) => zoom(Number(event.currentTarget.value))}
      class="min-w-0 flex-1 cursor-pointer accent-primary"
    />
    <ZoomIn class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <output for={zoomId} class="w-12 text-right text-xs tabular-nums text-muted-foreground"
      >{Math.round(crop.zoom * 100)}%</output
    >
  </div>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <Button variant="outline" size="sm" {disabled} onclick={() => (crop = rotateCrop(source, crop))}
      ><RotateCw aria-hidden="true" />{t("profile.rotate")}</Button
    >
    <Button variant="ghost" size="sm" {disabled} onclick={() => (crop = { ...DEFAULT_CROP })}
      ><RotateCcw aria-hidden="true" />{t("profile.reset")}</Button
    >
  </div>
</div>

<style>
  .crop-mask {
    background: radial-gradient(
      circle closest-side,
      transparent calc(100% - 1px),
      rgb(0 0 0 / 0.6) 100%
    );
  }
</style>
