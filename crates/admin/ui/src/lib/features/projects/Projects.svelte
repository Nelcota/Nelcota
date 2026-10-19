<script lang="ts">
  import { onMount } from 'svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import Boxes from '@lucide/svelte/icons/boxes'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Copy from '@lucide/svelte/icons/copy'
  import CircleCheck from '@lucide/svelte/icons/circle-check'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import Plus from '@lucide/svelte/icons/plus'
  import CodeBlock from '$lib/components/shared/CodeBlock.svelte'
  import HostLink from '../host/HostLink.svelte'
  import mascot from '../../../assets/mascot.png'
  import { Button } from '$lib/components/ui/button'
  import { toast } from 'svelte-sonner'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import { copyText } from '$lib/browser/clipboard'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import { api } from '$lib/transport/api'
  import { href } from '$lib/navigation/router.svelte'
  import { openProject } from '$lib/features/projects/projects'
  import type { ProjectStatus, ProjectsData } from '$lib/contracts/types'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  const resource = new RemoteResource<{ projects: ProjectStatus[]; sso: boolean }>()
  const projects = $derived(resource.data?.projects ?? null)
  const sso = $derived(resource.data?.sso ?? false)
  const failure = $derived(resource.error)
  const refreshing = $derived(resource.loading)
  async function load() {
    await resource.load(async signal => {
      const [list, status] = await Promise.all([
        api.get<ProjectsData>('/projects', { signal }),
        api.get<{ projects: ProjectStatus[] }>('/projects/status', { signal }),
      ])
      return { sso: list.sso, projects: status.projects.length ? status.projects : list.projects.map(p => ({ ...p, healthy: true, version: null, latency_ms: null })) }
    })
  }
  onMount(() => { void load(); return () => resource.cancel() })

  async function open(project: ProjectStatus) {
    try {
      await openProject(project, sso)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  // The address to copy: the project's own, or this page's origin for the
  // panel being looked at (the server only lists other projects' URLs).
  const address = (project: ProjectStatus) => project.url ?? (project.current ? location.origin : null)
</script>

<div class="mx-auto grid w-full max-w-page gap-6 px-4 pt-2 pb-12 *:min-w-0 sm:px-6 lg:px-8 [&>:first-child]:mb-0">
  <PageHeader
    title={t('projects.title')}
    description={projects ? (sso ? t('projects.sso') : t('projects.separateLogin')) : undefined}
  >
    {#snippet actions()}
      <Button variant="outline" onclick={load} disabled={refreshing}><RefreshCw data-icon="inline-start" class={refreshing ? 'animate-spin' : ''} aria-hidden="true" />{refreshing ? t('projects.refreshing') : t('common.refresh')}</Button>
    {/snippet}
  </PageHeader>

  {#if failure}<LoadError message={errorMessage(failure)} onretry={load} busy={refreshing} />{/if}
  {#if (!projects && refreshing)}
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each [0, 1, 2] as i (i)}<Skeleton class="h-40 rounded-3xl" />{/each}
    </div>
  {/if}
  {#if !(!projects && refreshing) && (projects)}
    {#if projects.length === 0}<EmptyState icon={Boxes} title={t('projects.empty')} description={t('projects.emptyDescription')} />{/if}
    <div class="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each projects as project (project.name)}
        {@const url = address(project)}
        <article class={['flex flex-col gap-4 rounded-3xl bg-card p-5', project.current && 'ring-1 ring-brand/40']}>
          <div class="flex items-center gap-3">
            <span class="grid size-11 shrink-0 place-items-center rounded-full bg-well"><img src={mascot} alt="" class="size-8 select-none" draggable="false" /></span>
            <div class="grid min-w-0 flex-1">
              <p class="truncate font-semibold">{project.name}</p>
              {#if url}
                <p class="flex min-w-0 items-center gap-1 font-mono text-xs text-muted-foreground">
                  <span class="truncate" title={url}>{host(url)}</span>
                  <Button variant="ghost" size="icon-xs" aria-label={t('projects.copyUrl', { name: project.name })} title={t('projects.copyUrl', { name: project.name })} onclick={() => copyText(url)}><Copy aria-hidden="true" /></Button>
                </p>
              {/if}
            </div>
            {#if project.current}<span class="shrink-0 rounded-full bg-brand/15 px-2.5 py-1 text-xs font-medium text-brand">{t('projects.current')}</span>{/if}
          </div>

          <div class="flex items-center gap-2 rounded-2xl bg-well px-4 py-3 text-sm">
            {#if (project.healthy)}
              <CircleCheck class="size-4 text-brand" aria-hidden="true" />
              <span>{t('projects.up')}</span>
              {#if project.latency_ms !== null}
                <span class="text-muted-foreground tabular-nums">· {project.latency_ms} ms</span>
              {/if}
            {/if}
            {#if !(project.healthy)}
              <CircleAlert class="size-4 text-destructive" aria-hidden="true" />
              <span class="text-destructive">{t('projects.down')}</span>
            {/if}
            {#if project.version}<span class="ml-auto font-mono text-xs text-muted-foreground">v{project.version.replace(/^v/, '')}</span>{/if}
          </div>

          {#if (project.current)}
            <Button variant="outline" class="w-full" href={href('/')}>{t('projects.back')}</Button>
          {/if}
          {#if !(project.current) && (project.url)}
            <Button variant="outline" class="w-full" onclick={() => open(project)}>
              {t('projects.open')}<ArrowUpRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          {/if}
        </article>
      {/each}

      <!-- How to add one, as the last tile. -->
      <article class="flex flex-col gap-3 rounded-3xl border-2 border-dashed border-border p-5">
        <p class="flex items-center gap-2 font-semibold"><Plus class="size-4 text-muted-foreground" aria-hidden="true" />{t('projects.newProject.title')}</p>
        <HostLink />
        <p class="text-sm text-muted-foreground">{t('projects.newProject.subdomain')}</p>
        <CodeBlock code={t('projects.newProject.subdomainCommand')} lang="sh" />
        <p class="text-sm text-muted-foreground">{t('projects.newProject.domain')}</p>
        <CodeBlock code={t('projects.newProject.domainCommand')} lang="sh" />
      </article>
    </div>
  {/if}
</div>
