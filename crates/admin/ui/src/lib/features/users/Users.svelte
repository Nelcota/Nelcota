<script lang="ts">
  import UsersIcon from '@lucide/svelte/icons/users'
  import { dateText } from '$lib/formatting/date'
  import { untrack } from 'svelte'
  import * as Table from '$lib/components/ui/table'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Button } from '$lib/components/ui/button'
  import SearchField from '$lib/components/shared/SearchField.svelte'
  import { Skeleton } from '$lib/components/ui/skeleton'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import Search from '@lucide/svelte/icons/search'
  import UserPlus from '@lucide/svelte/icons/user-plus'
  import Copy from '@lucide/svelte/icons/copy'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LogOut from '@lucide/svelte/icons/log-out'
  import MailCheck from '@lucide/svelte/icons/mail-check'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import { Badge } from '$lib/components/ui/badge'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import { toast } from 'svelte-sonner'
  import PageHeader from '$lib/components/shared/PageHeader.svelte'
  import EmptyState from '$lib/components/shared/EmptyState.svelte'
  import LoadError from '$lib/components/shared/LoadError.svelte'
  import ConfirmDialog from '$lib/components/shared/ConfirmDialog.svelte'
  import CreateUserDialog from '$lib/features/users/components/CreateUserDialog.svelte'
  import SetPasswordDialog from '$lib/features/users/components/SetPasswordDialog.svelte'
  import { api, enc } from '$lib/transport/api'
  import { navigate, route } from '$lib/navigation/router.svelte'
  import { copyText } from '$lib/browser/clipboard'
  import { RemoteResource } from '$lib/resources/remote-resource.svelte'
  import type { UsersResponse, User } from '$lib/contracts/types'
  import { errorMessage, intlLocale, t } from '$lib/i18n/index.svelte'
  import { signInMethods } from '$lib/features/users/sign-in-methods'
  import { pageAfterEmpty, parsePage } from '$lib/navigation/pagination'

  const resource = new RemoteResource<UsersResponse>()
  const users = $derived(resource.data?.users ?? null)
  const total = $derived(resource.data?.total ?? 0)
  const page = $derived(parsePage(route.query.get('page')))
  const appliedQuery = $derived(route.query.get('q') ?? '')
  const hasNext = $derived(resource.data?.has_next ?? false)
  let query = $state('')
  const loading = $derived(resource.loading)
  const error = $derived(resource.error ? errorMessage(resource.error) : '')

  function go(nextPage: number, nextQuery = appliedQuery, replace = false) {
    const params = new URLSearchParams()
    if (nextPage) params.set('page', String(nextPage))
    if (nextQuery) params.set('q', nextQuery)
    navigate(`/users${params.size ? `?${params}` : ''}`, replace)
  }
  let target = $state<{ user: User; action: 'revoke' | 'delete' } | null>(null)
  let confirmOpen = $state(false)
  let createOpen = $state(false)
  let passwordUser = $state<User | null>(null)
  let passwordOpen = $state(false)

  $effect(() => {
    if (route.query.get('create') === 'true') {
      createOpen = true
      const params = new URLSearchParams(route.query)
      params.delete('create')
      navigate(`/users${params.size ? `?${params}` : ''}`, true)
    }
  })

  async function load() {
    const params = new URLSearchParams({ page: String(page) })
    if (appliedQuery) params.set('q', appliedQuery)
    await resource.load(signal => api.get<UsersResponse>(`/users?${params}`, { signal }))
  }

  $effect(() => {
    void [page, appliedQuery]
    untrack(load)
    return () => resource.cancel()
  })

  // The server lists 50 users per page (crates/admin/src/users/operations.rs).
  const PAGE_SIZE = 50
  // Deleting the last user of a page past the first, or a stale `page` link,
  // moves to the last page instead of reading "no users yet".
  $effect(() => {
    const data = resource.data
    if (!data || loading || data.users.length > 0 || data.page !== page) return
    const next = pageAfterEmpty(page, PAGE_SIZE, data.total, true)
    if (next !== null) untrack(() => go(next, appliedQuery, true))
  })

  // Copy the URL into the field only when it says something else (back/forward,
  // a cleared search): rewriting it after a debounce would drop the trailing
  // space the person just typed.
  $effect(() => {
    const applied = appliedQuery
    untrack(() => { if (query.trim() !== applied) query = applied })
  })

  let debounce: ReturnType<typeof setTimeout>
  function onSearch() {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      go(0, query.trim(), true)
    }, 250)
  }

  $effect(() => () => clearTimeout(debounce))

  function ask(user: User, action: 'revoke' | 'delete') {
    target = { user, action }
    confirmOpen = true
  }

  async function confirmEmail(user: User) {
    try {
      await api.post(`/users/${enc(user.id)}/confirm`)
      toast.success(t('users.emailConfirmed', { email: user.email }))
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  async function confirm() {
    if (!target) return
    const { user, action } = target
    try {
      if (action === 'revoke') {
        await api.post(`/users/${enc(user.id)}/revoke`)
        toast.success(t('users.revoked', { email: user.email }))
        await load()
        return
      }
      await api.delete(`/users/${enc(user.id)}`)
      toast.success(t('users.deleted', { email: user.email }))
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
      throw e
    }
  }

  const date = $derived(new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }))
  const when = (value: string | null) => dateText(value, date.format)
</script>

{#snippet unconfirmed(user: User)}
  {#if !user.email_confirmed_at}
    <!-- Focusable so keyboard users reach the hint, not only mouse hover. -->
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Badge {...props} variant="outline" tabindex={0} class="ml-2 cursor-help align-middle font-normal text-muted-foreground">{t('users.unconfirmed')}</Badge>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>{t('users.unconfirmedHint')}</Tooltip.Content>
    </Tooltip.Root>
  {/if}
{/snippet}

{#snippet userId(user: User)}
  <!-- The id is what policies and support tickets use: shown whole on hover, one click to copy. -->
  <span class="group/id flex min-w-0 items-center gap-1">
    <span class="min-w-0 truncate font-mono text-xs text-muted-foreground" title={user.id}>{user.id}</span>
    <button type="button" class="-my-2 grid size-9 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={t('users.copyIdOf', { email: user.email })} title={t('users.copyId')} onclick={() => copyText(user.id, t('users.idCopied'))}><Copy class="size-3.5" aria-hidden="true" /></button>
  </span>
{/snippet}

{#snippet methods(user: User)}
  {@const list = signInMethods(user)}
  <span class="inline-flex flex-wrap gap-1" title={list[0].kind === 'linkOnly' ? t('users.methods.linkOnlyHint') : undefined}>
    {#each list as method, i (i)}<span class={['rounded-md bg-well px-2 py-0.5 text-xs font-medium', method.kind === 'linkOnly' ? 'text-muted-foreground' : '']}>{#if (method.kind === 'password')}{t('users.methods.password')}{/if}{#if !(method.kind === 'password') && (method.kind === 'provider')}{method.name}{/if}{#if !(method.kind === 'password') && !(method.kind === 'provider')}{t('users.methods.linkOnly')}{/if}{#if list[0].kind === 'linkOnly'}<span class="sr-only">{t('users.methods.linkOnlyHint')}</span>{/if}</span>{/each}
  </span>
{/snippet}

{#snippet userActions(user: User)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button variant="ghost" size="icon-sm" aria-label={t('common.actionsFor', { name: user.email })} {...props}><Ellipsis aria-hidden="true" /></Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="w-56">
      <DropdownMenu.Group>
        <DropdownMenu.Item onclick={() => copyText(user.id, t('users.idCopied'))}><Copy aria-hidden="true" />{t('users.copyId')}</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => { passwordUser = user; passwordOpen = true }}><KeyRound aria-hidden="true" />{t('users.resetPassword')}</DropdownMenu.Item>
        {#if !user.email_confirmed_at}
          <DropdownMenu.Item onclick={() => confirmEmail(user)}><MailCheck aria-hidden="true" />{t('users.confirmEmail')}</DropdownMenu.Item>
        {/if}
        <DropdownMenu.Item onclick={() => ask(user, 'revoke')}><LogOut aria-hidden="true" />{t('users.revokeSessions')}</DropdownMenu.Item>
      </DropdownMenu.Group>
      <DropdownMenu.Separator />
      <DropdownMenu.Group><DropdownMenu.Item variant="destructive" onclick={() => ask(user, 'delete')}><Trash2 aria-hidden="true" />{t('users.delete')}</DropdownMenu.Item></DropdownMenu.Group>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

<div class="mx-auto w-full max-w-page px-4 pt-2 pb-12 sm:px-6 lg:px-8">
  <PageHeader
    title={t('users.title')}
    description={users ? (appliedQuery ? t('users.matchCount', { count: total, query: appliedQuery }) : t('users.count', { count: total })) : t('users.description')}
  >
    {#snippet actions()}
      <Button onclick={() => (createOpen = true)}><UserPlus data-icon="inline-start" aria-hidden="true" />{t('users.new')}</Button>
    {/snippet}
  </PageHeader>

  <!-- List toolbar: search on the left, filters beside it; the header keeps only buttons. -->
  <div class="mb-4 flex flex-wrap items-center gap-3">
    <div class="w-full sm:w-72"><SearchField bind:value={query} oninput={onSearch} placeholder={t('users.searchPlaceholder')} label={t('users.searchLabel')} /></div>
  </div>

  {#if error}<LoadError message={error} onretry={load} busy={loading} />{/if}
  {#if (users === null)}
    {#if loading}<Skeleton class="h-64 rounded-3xl" />{/if}
  {/if}
  {#if !(users === null) && (users.length === 0)}
    <EmptyState
      class="rounded-3xl bg-card"
      icon={appliedQuery ? Search : UsersIcon}
      title={appliedQuery ? t('users.noResults') : t('users.empty')}
      description={appliedQuery
        ? t('users.noResultsFor', { query: appliedQuery })
        : t('users.emptyDescription')}
    >
      {#snippet actions()}
        {#if (appliedQuery)}
          <Button
            variant="outline"
            onclick={() => {
              go(0, '')
            }}>{t('users.clearSearch')}</Button
          >
        {/if}
        {#if !(appliedQuery)}
          <Button variant="outline" onclick={() => (createOpen = true)}><UserPlus data-icon="inline-start" aria-hidden="true" />{t('users.new')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {/if}
  {#if !(users === null) && !(users.length === 0)}
    <div class="grid gap-3 md:hidden" aria-busy={loading}>
      {#each users as user (user.id)}
        <article class="min-w-0 rounded-3xl bg-card p-4">
          <div class="flex min-w-0 items-start justify-between gap-2">
            <div class="min-w-0"><p class="break-all font-medium">{user.email}{@render unconfirmed(user)}</p><div class="mt-1">{@render userId(user)}</div></div>
            {@render userActions(user)}
          </div>
          <dl class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            <dt class="text-muted-foreground">{t('users.columns.signIn')}</dt><dd class="text-right">{@render methods(user)}</dd>
            <dt class="text-muted-foreground">{t('users.columns.lastSignIn')}</dt><dd class={['text-right', user.last_sign_in_at ? '' : 'text-muted-foreground']}>{user.last_sign_in_at ? when(user.last_sign_in_at) : t('users.neverSignedIn')}</dd>
            <dt class="text-muted-foreground">{t('users.columns.created')}</dt><dd class="text-right">{when(user.created_at)}</dd>
            <dt class="text-muted-foreground">{t('users.columns.sessions')}</dt><dd class="text-right tabular-nums">{user.sessions}</dd>
          </dl>
        </article>
      {/each}
    </div>
    <div class="hidden overflow-hidden rounded-3xl bg-card md:block" aria-busy={loading}>
      <Table.Root>
        <Table.Header>
          <Table.Row class="hover:bg-transparent">
            <Table.Head>{t('users.columns.email')}</Table.Head>
            <Table.Head>{t('users.columns.signIn')}</Table.Head>
            <Table.Head>{t('users.columns.created')}</Table.Head>
            <Table.Head>{t('users.columns.lastSignIn')}</Table.Head>
            <Table.Head class="text-right">{t('users.columns.sessions')}</Table.Head>
            <Table.Head class="w-12"><span class="sr-only">{t('common.actions')}</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each users as user (user.id)}
            <Table.Row>
              <Table.Cell>
                <div class="flex items-center gap-3">
                  <span
                    class="grid size-9 shrink-0 place-items-center rounded-full bg-well text-xs font-semibold text-muted-foreground"
                    aria-hidden="true">{user.email.charAt(0).toUpperCase()}</span
                  >
                  <div class="min-w-0">
                    <p class="font-medium">{user.email}{@render unconfirmed(user)}</p>
                    <div class="max-w-72">{@render userId(user)}</div>
                  </div>
                </div>
              </Table.Cell>
              <Table.Cell>{@render methods(user)}</Table.Cell>
              <!-- Dates stay secondary to the email; no sessions reads as muted, like "never". -->
              <Table.Cell class="text-muted-foreground tabular-nums">{when(user.created_at)}</Table.Cell>
              <Table.Cell class="text-muted-foreground tabular-nums">{user.last_sign_in_at ? when(user.last_sign_in_at) : t('users.neverSignedIn')}</Table.Cell>
              <Table.Cell class={['text-right tabular-nums', user.sessions ? '' : 'text-muted-foreground']}>{user.sessions}</Table.Cell>
              <Table.Cell class="text-right">
                {@render userActions(user)}
              </Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
      </Table.Root>
    </div>
  {/if}

  {#if page > 0 || hasNext}
    <nav class="mt-4 flex items-center justify-end gap-2" aria-label={t('users.pagination')}>
      <span class="mr-1 text-sm text-muted-foreground">{t('common.page', { page: page + 1 })}</span>
      <Button variant="outline" size="sm" disabled={loading || page === 0} onclick={() => go(page - 1)}>{t('common.previous')}</Button>
      <Button variant="outline" size="sm" disabled={loading || !hasNext} onclick={() => go(page + 1)}>{t('common.next')}</Button>
    </nav>
  {/if}
</div>

<CreateUserDialog bind:open={createOpen} oncreated={load} />
{#if passwordUser}
  <SetPasswordDialog bind:open={passwordOpen} user={passwordUser} onsaved={load} />
{/if}

{#if target}
  <ConfirmDialog
    bind:open={confirmOpen}
    title={target.action === 'revoke' ? t('users.confirmRevoke.title') : t('users.confirmDelete.title')}
    description={target.action === 'revoke'
      ? t('users.confirmRevoke.description', { email: target.user.email })
      : t('users.confirmDelete.description', { email: target.user.email })}
    confirmLabel={target.action === 'revoke' ? t('users.revokeSessions') : t('common.delete')}
    destructive={target.action === 'delete'}
    onconfirm={confirm}
  />
{/if}
