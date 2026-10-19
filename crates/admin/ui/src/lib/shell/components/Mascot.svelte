<script lang="ts" module>
  import neutral from '../../../assets/mascot/neutral.png'
  import wave from '../../../assets/mascot/wave.png'
  import eyesClosed from '../../../assets/mascot/eyes-closed.png'
  import sad from '../../../assets/mascot/sad.png'

  const frames = { neutral, wave, eyesClosed, sad }
  export type Pose = keyof typeof frames
</script>

<script lang="ts">
  import { EYES, EYE_ANGLE, FRAME_SIZE, approach, gazeAt, pupilOffset, type Point } from '$lib/shell/mascot'
  import { cn } from '$lib/components/utils'

  let {
    pose = 'neutral',
    lookAt = null,
    class: className = '',
  }: {
    pose?: Pose
    /** Screen point to look at (e.g. the text being typed); without it, follows the pointer. */
    lookAt?: Point | null
    class?: string
  } = $props()

  const ahead = () => EYES.map(() => ({ x: 0, y: 0 }))

  let root = $state<HTMLDivElement>()
  let pointer = $state<Point | null>(null)
  // Current direction of each eye, smoothed every frame.
  let gaze = $state<Point[]>(ahead())

  const target = $derived(lookAt ?? pointer)
  const open = $derived(pose !== 'eyesClosed')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')

  // Animates only until the gaze reaches its target; at rest it spends no frames.
  let frame = 0
  function tick() {
    frame = 0
    if (!root) return
    const desired = target ? gazeAt(root.getBoundingClientRect(), target) : ahead()
    const next = gaze.map((g, i) => approach(g, desired[i], reduced.matches ? 1 : 0.18))
    const moving = next.some((g, i) => Math.hypot(g.x - desired[i].x, g.y - desired[i].y) > 0.002)
    gaze = moving ? next : desired
    if (moving) frame = requestAnimationFrame(tick)
  }

  $effect(() => {
    void target
    if (!frame) frame = requestAnimationFrame(tick)
  })
  $effect(() => () => cancelAnimationFrame(frame))

  function onMove(e: PointerEvent) {
    pointer = { x: e.clientX, y: e.clientY }
  }
  // Pointer left the window: look straight ahead again.
  function onLeave(e: MouseEvent) {
    if (!e.relatedTarget) pointer = null
  }
</script>

<svelte:window onpointermove={onMove} />
<svelte:document onmouseout={onLeave} />

<!-- cn: callers can swap `relative` for `absolute` without a class conflict. -->
<div bind:this={root} class={cn('relative select-none', className)} aria-hidden="true">
  <!-- Every pose stays loaded: switching expressions never flickers. -->
  {#each Object.entries(frames) as [name, src] (name)}
    <img {src} alt="" draggable="false" class={['absolute inset-0 size-full', pose !== name && 'invisible']} />
  {/each}

  <!-- Vector eyes over the drawn ones: only the pupil moves. -->
  {#if open}
    <svg viewBox="0 0 {FRAME_SIZE} {FRAME_SIZE}" class="absolute inset-0 size-full">
      {#each EYES as eye, i (i)}
        {@const p = pupilOffset(gaze[i], eye)}
        <g transform="translate({eye.x} {eye.y}) rotate({EYE_ANGLE})">
          <ellipse rx={eye.rx} ry={eye.ry} fill="#fcfaef" />
          <ellipse cx={p.x} cy={p.y} rx={eye.pupilRx} ry={eye.pupilRy} fill="#231f19" />
        </g>
      {/each}
    </svg>
  {/if}
</div>
