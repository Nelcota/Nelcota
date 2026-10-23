<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { t, i18n, translate } from '$lib/i18n/index.svelte'
  import { request, ControllerError } from '../updates/controller'
  import { parseDiagnostics, type Diagnostics } from './contracts'
  let { project, expired }: { project: string; expired: () => void } = $props()
  let data = $state<Diagnostics | null>(null), loading = $state(false), error = $state(false)
  let generation = 0, alive = true
  let controller: AbortController | undefined
  const s = (key: string) => translate(i18n.locale, `server.${key}`)
  const size = (bytes: number | null) => bytes === null ? s('unavailable') : `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  async function load() {
    controller?.abort()
    controller = new AbortController()
    const abort = controller, revision = ++generation, selected = project
    const timer = setTimeout(() => abort.abort(), 20000)
    loading = true; error = false
    try {
      const reply = await request({ action: 'host_diagnostics', project: selected }, abort.signal)
      if (!alive || revision !== generation) return
      const next = parseDiagnostics(reply.data)
      if (next.project !== selected) throw new Error('project mismatch')
      data = next
    } catch (e) {
      if (!alive || revision !== generation) return
      if (e instanceof ControllerError && e.status === 401) { expired(); return }
      error = true
    } finally { clearTimeout(timer); if (alive && revision === generation) loading = false }
  }
  $effect(() => { if (project) { data = null; void load() } })
  onDestroy(() => { alive = false; generation++; controller?.abort() })
</script>
<section class="grid gap-5 rounded-3xl border border-border bg-card p-6" aria-busy={loading} aria-labelledby="server-health-title">
  <div class="flex flex-wrap items-start justify-between gap-3"><div><h2 id="server-health-title" class="text-xl font-semibold">{s('health')}</h2><p class="mt-1 text-sm text-muted-foreground">{s('readOnly')}</p></div><Button disabled={loading || !project} onclick={() => void load()}>{loading ? s('refreshing') : s('diagnose')}</Button></div>
  {#if error}<p role="alert" class="text-sm text-destructive">{s('error')}</p>{/if}
  {#if data}<p class="text-xs text-muted-foreground">{s('checked')}: {new Date(data.checked_at * 1000).toLocaleString(i18n.locale)}</p>
    <dl class="grid gap-3 sm:grid-cols-2">
      {#each [[s('cpu'), data.cpu_percent === null ? s('unavailable') : `${data.cpu_percent.toFixed(1)}%`], [s('memory'), `${size(data.memory_available_bytes)} / ${size(data.memory_total_bytes)}`], [s('disk'), size(data.free_bytes)], [s('load'), data.load_one === null ? s('unavailable') : data.load_one.toFixed(2)]] as [label, value]}
        <div class="rounded-2xl bg-well p-4"><dt class="text-sm text-muted-foreground">{label}</dt><dd class="mt-1 text-xl font-semibold">{value}</dd></div>
      {/each}
    </dl>
    <ul class="grid gap-2">{#each data.checks as check (check.name)}<li class="flex items-center justify-between gap-4 rounded-2xl border border-border px-4 py-3"><span>{s(check.name) === `server.${check.name}` ? s('unavailable') : s(check.name)}</span><span class={`text-sm font-medium ${check.status === 'failed' ? 'text-destructive' : check.status === 'passed' ? 'text-success' : 'text-amber-700 dark:text-amber-300'}`}>{s(check.status)}</span></li>{/each}</ul>
  {/if}
  <p class="text-sm text-muted-foreground">{s('pendingUpdate')}</p>
</section>
