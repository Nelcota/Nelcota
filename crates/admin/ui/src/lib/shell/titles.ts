// Page names: the topbar breadcrumb and the browser tab title.
import { hasMessage, t, type MessageKey } from '$lib/i18n/index.svelte'
import { match } from '$lib/navigation/route-match'

const titles: Record<string, MessageKey> = {
  '/': 'shell.pages.overview',
  '/tables': 'shell.pages.tables',
  '/sql': 'shell.pages.sql',
  '/migrations': 'shell.pages.migrations',
  '/users': 'shell.pages.users',
  '/sign-in': 'shell.pages.userSignIn',
  '/storage': 'shell.pages.storage',
  '/policies': 'shell.pages.policies',
  '/updates': 'shell.pages.updates',
  '/projects': 'shell.pages.projects',
  '/connect': 'shell.pages.connect',
  '/guides': 'shell.pages.guides',
  '/webhooks': 'shell.pages.webhooks',
}

export type Crumb = { label: string; path?: string }

/** Breadcrumb of the current page (topbar); joined, it is the tab title. */
export function crumbsFor(path: string): Crumb[] {
  const delivery = match('/webhooks/deliveries/:id', path.replace(/\/$/, ''))
  if (delivery) return [{ label: t('shell.pages.webhooks'), path: '/webhooks?tab=deliveries' }, { label: t('webhooks.deliveryTitle', { id: delivery.id }) }]
  const guide = match('/guides/:id', path.replace(/\/$/, ''))
  const guideTitle = `guides.entries.${guide?.id}.title`
  if (guide && hasMessage(guideTitle)) return [{ label: t('shell.pages.guides'), path: '/guides' }, { label: t(guideTitle as MessageKey) }]
  const table = match('/tables/:name', path)
  if (table) return [{ label: t('shell.pages.tables'), path: '/tables' }, { label: table.name }]
  const bucket = match('/storage/:bucket', path)
  if (bucket) return [{ label: t('shell.pages.storage'), path: '/storage' }, { label: bucket.bucket }]
  const structure = match('/tables/:name/structure', path)
  if (structure) {
    return [
      { label: t('shell.pages.tables'), path: '/tables' },
      { label: structure.name, path: `/tables/${encodeURIComponent(structure.name)}` },
      { label: t('shell.pages.structure') },
    ]
  }
  return [{ label: t(titles[path.replace(/\/$/, '') || '/'] ?? 'shell.pages.notFound') }]
}

/** Browser tab title: most specific first, product name last. */
export const documentTitle = (crumbs: Crumb[]) =>
  [...crumbs.map((c) => c.label).reverse(), 'Nelcota'].join(' · ')
