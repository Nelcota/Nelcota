<script lang="ts">
  // A share as a ring: the track is a lighter step of the fill (D98).
  let { value, label }: { value: number; label: string } = $props()
  const R = 22
  const C = 2 * Math.PI * R
  const clamped = $derived(Math.min(100, Math.max(0, value)))
</script>

<svg viewBox="0 0 56 56" class="size-12 shrink-0" role="img" aria-label={label}>
  <circle cx="28" cy="28" r={R} fill="none" class="stroke-success/15" stroke-width="3.5" />
  <circle
    cx="28"
    cy="28"
    r={R}
    fill="none"
    class="stroke-success"
    stroke-width="3.5"
    stroke-linecap="round"
    stroke-dasharray={`${(clamped / 100) * C} ${C}`}
    transform="rotate(-90 28 28)"
  />
  <text x="28" y="28" dy="0.35em" text-anchor="middle" class="fill-foreground text-3xs font-medium">{clamped}%</text>
</svg>
