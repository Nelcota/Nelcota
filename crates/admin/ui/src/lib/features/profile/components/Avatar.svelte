<script lang="ts">
  import { avatarUrl, profile } from '$lib/features/profile/profile.svelte'
  import { session } from '$lib/resources/session.svelte'
  import { cn } from '$lib/components/utils'

  // The admin's photo or, without one, two letters of the email on the brand
  // green (D98). `src` forces an image (preview of a photo not saved yet).
  let { src = null, class: className = '' }: { src?: string | null; class?: string } = $props()

  const initial = $derived(
    ((session.email ?? '?').split('@')[0]!.replace(/[^\p{L}\p{N}]/gu, '') || '?').slice(0, 2).toUpperCase(),
  )
  const url = $derived(src ?? (profile.avatar !== null ? avatarUrl(profile.avatar) : null))
  // Image that failed to load (removed in another tab, for example): show the initial.
  let failed = $state<string | null>(null)
</script>

<span
  class={cn(
    'grid shrink-0 place-items-center overflow-hidden rounded-full bg-primary font-semibold text-primary-foreground',
    className,
  )}
>
  {#if (url && failed !== url)}
    <img src={url} alt="" class="size-full object-cover" draggable="false" onerror={() => (failed = url)} />
  {/if}
  {#if !(url && failed !== url)}
    {initial}
  {/if}
</span>
