<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Check from '@lucide/svelte/icons/check'
  import Boxes from '@lucide/svelte/icons/boxes'
  import FolderClosed from '@lucide/svelte/icons/folder-closed'
  import { toast } from 'svelte-sonner'
  import { api } from '$lib/transport/api'
  import { openProject } from '$lib/features/projects/projects'
  import { navigate } from '$lib/navigation/router.svelte'
  import { errorMessage, t } from '$lib/i18n/index.svelte'
  import type { ProjectsData } from '$lib/contracts/types'
  import { environment, health, watchHealth } from '$lib/shell/health.svelte'
  import { cn } from '$lib/components/utils'

  let {
    menuOpen = $bindable(false),
    expanded = false,
  }: {
    menuOpen?: boolean
    /** Include the project icon in the phone menu as well as the name and status. */
    expanded?: boolean
  } = $props()

  const hintId = $props.id()

  const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

  let data = $state<ProjectsData | null>(null)
  let loading = $state(true)

  // Keep the project identity and environment readable at every width.
  const env = environment()
  const where = env.local ? t('shell.projects.environment.local') : t('shell.projects.environment.remote', { host: env.host })
  const status = $derived(t(`shell.projects.server.${health.status}`))

  onMount(async () => {
    watchHealth()
    try {
      data = await api.get<ProjectsData>('/projects')
    } catch {
      data = null
    } finally {
      loading = false
    }
  })

  async function open(name: string) {
    const project = data?.projects.find((p) => p.name === name)
    if (!project || !data) return
    try {
      await openProject(project, data.sso)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
</script>

{#snippet trigger(props: Record<string, unknown> = {})}
  <Button
    {...props}
    variant="ghost"
    class="group/project h-auto min-h-12 w-full min-w-0 justify-start gap-2.5 rounded-lg px-1.5 py-1 text-left sm:px-2"
    disabled={!data}
    aria-busy={loading}
    aria-describedby={!data ? hintId : undefined}
    title={data ? `${t('shell.projects.switch')} · ${status}` : t(loading ? 'shell.projects.loading' : 'shell.projects.unavailable')}
    aria-label={`${t('shell.projects.switch')}: ${data?.current ?? 'Nelcota'} · ${status}`}
  >
    <span class={cn('relative size-9 shrink-0 place-items-center', expanded ? 'grid' : 'hidden sm:grid')}>
      <FolderClosed class="size-5 text-muted-foreground" strokeWidth={1.6} aria-hidden="true" />
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-1 leading-tight">
      <span class="line-clamp-2 text-sm font-semibold whitespace-normal [overflow-wrap:anywhere]" translate="no">{data?.current ?? 'Nelcota'}</span>
      <span class="flex min-w-0 items-center gap-1.5">
        <span
          class={cn(
            'size-1.5 shrink-0 rounded-full',
            health.status === 'online' ? 'bg-success' : health.status === 'offline' ? 'bg-destructive' : 'bg-muted-foreground',
          )}
          role="img"
          aria-label={status}
        ></span>
        <!-- Offline is an alert: wrap it instead of truncating it in a narrow sidebar. -->
        <span id={hintId} class={cn('text-xs font-normal', health.status === 'offline' ? 'whitespace-normal text-destructive [overflow-wrap:anywhere]' : 'truncate text-muted-foreground')}>{health.status === 'offline' ? status : data ? where : t(loading ? 'shell.projects.loading' : 'shell.projects.unavailable')}</span>
      </span>
    </span>
    <ChevronDown data-icon="inline-end" class="hidden text-muted-foreground transition-transform duration-150 group-aria-expanded/project:rotate-180 sm:block" aria-hidden="true" />
  </Button>
{/snippet}

{#if (data)}
  <DropdownMenu.Root bind:open={menuOpen}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}{@render trigger(props)}{/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="min-w-72">
      <DropdownMenu.Group>
        <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
          {data.sso ? t('shell.projects.heading') : t('shell.projects.separateLogin')}
        </DropdownMenu.Label>
        {#each data.projects as project (project.name)}
          <DropdownMenu.Item disabled={!project.url && !project.current} onclick={() => open(project.name)}>
            <span class="grid min-w-0 flex-1">
              <span class="truncate">{project.name}</span>
              {#if project.url}<span class="truncate font-mono text-xs text-muted-foreground">{host(project.url)}</span>{/if}
            </span>
            {#if project.current}<Check class="text-brand" />{/if}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Group>
      <DropdownMenu.Separator />
      <DropdownMenu.Group>
        <DropdownMenu.Item onclick={() => navigate('/projects')}><Boxes />{t('shell.projects.all')}</DropdownMenu.Item>
      </DropdownMenu.Group>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
{#if !(data)}
  {@render trigger()}
{/if}
