import type { Component } from 'svelte'
import House from '@lucide/svelte/icons/house'
import Rows3 from '@lucide/svelte/icons/rows-3'
import SquareTerminal from '@lucide/svelte/icons/square-terminal'
import History from '@lucide/svelte/icons/history'
import Database from '@lucide/svelte/icons/database'
import Users from '@lucide/svelte/icons/users'
import ShieldCheck from '@lucide/svelte/icons/shield-check'
import Boxes from '@lucide/svelte/icons/boxes'
import Plug from '@lucide/svelte/icons/plug'
import HardDrive from '@lucide/svelte/icons/hard-drive'
import LogIn from '@lucide/svelte/icons/log-in'
import BookOpen from '@lucide/svelte/icons/book-open'
import Webhook from '@lucide/svelte/icons/webhook'
import Globe from '@lucide/svelte/icons/globe'
import UserRound from '@lucide/svelte/icons/user-round'
import Package from '@lucide/svelte/icons/package'
import CodeXml from '@lucide/svelte/icons/code-xml'
import KeyRound from '@lucide/svelte/icons/key-round'
import ArrowUpCircle from '@lucide/svelte/icons/arrow-up-circle'
import { apiSectionLocation } from '$lib/navigation/api-sections.svelte'
import type { MessageKey } from '$lib/i18n/index.svelte'
import { route } from '$lib/navigation/router.svelte'

/** Titles are translation keys: render them with `t(item.title)`. */
export type NavItem = {
  title: MessageKey
  /** Short name on the top pill (defaults to the title). */
  pill?: MessageKey
  path: string
  icon: Component
  /** Other pages this pill stays lit for (sub-pages reached from it). */
  also?: string[]
  children?: readonly NavItem[]
  section?: string
  webhookView?: 'configuration' | 'deliveries'
}

export const databasePages = [
  { path: '/tables', title: 'shell.pages.tables', icon: Rows3 },
  { path: '/sql', title: 'shell.pages.sql', icon: SquareTerminal },
  { path: '/migrations', title: 'shell.pages.migrations', icon: History },
] as const satisfies readonly NavItem[]

export const apiSectionPages = ([
  { section: 'api-address', title: 'connect.address', icon: Globe },
  { section: 'api-roles', title: 'connect.caller', icon: UserRound },
  { section: 'api-sdk', title: 'connect.sdk.title', icon: Package },
  { section: 'api-examples', title: 'connect.examples', icon: CodeXml },
  { section: 'api-token', title: 'connect.token.title', icon: KeyRound },
] as const).map(item => ({ ...item, path: `/connect?section=${item.section}` })) satisfies NavItem[]

// Main navigation groups, shared by the workspace sidebar and mobile menu.
// Sign-in settings live under Users; /connect, not /api, since /admin/api/* is
// the panel API.
export const navPills: NavItem[] = [
  { title: 'shell.pages.overview', pill: 'shell.pills.overview', path: '/', icon: House },
  { title: 'shell.pages.database', pill: 'shell.pills.database', path: '/tables', icon: Database, also: ['/sql', '/migrations'], children: databasePages },
  { title: 'shell.pages.storage', pill: 'shell.pills.storage', path: '/storage', icon: HardDrive },
  { title: 'shell.pages.users', pill: 'shell.pills.users', path: '/users', icon: Users, also: ['/sign-in'], children: [
    { title: 'shell.nav.userList', path: '/users', icon: Users },
    { title: 'shell.pages.userSignIn', path: '/sign-in', icon: LogIn },
  ] },
  { title: 'shell.pages.policies', pill: 'shell.pills.policies', path: '/policies', icon: ShieldCheck },
  { title: 'shell.pages.webhooks', pill: 'shell.pills.webhooks', path: '/webhooks', icon: Webhook, children: [
    { title: 'webhooks.configuration', path: '/webhooks', icon: Webhook, webhookView: 'configuration' },
    { title: 'webhooks.deliveries', path: '/webhooks?tab=deliveries', icon: History, webhookView: 'deliveries' },
  ] },
  { title: 'shell.pages.connect', pill: 'shell.pills.connect', path: '/connect', icon: Plug, children: apiSectionPages },
]

// Every page the command palette can open: the groups, plus pages reached
// from inside them (sign-in from Users, projects from the project switcher).
export const navItems: NavItem[] = [
  navPills[0],
  { title: 'shell.pages.tables', path: '/tables', icon: Rows3 },
  { title: 'shell.pages.sql', path: '/sql', icon: SquareTerminal },
  { title: 'shell.pages.migrations', path: '/migrations', icon: History },
  ...navPills.slice(2),
  { title: 'shell.pages.userSignIn', path: '/sign-in', icon: LogIn },
  { title: 'shell.pages.projects', path: '/projects', icon: Boxes },
  { title: 'shell.pages.updates', path: '/updates', icon: ArrowUpCircle },
  { title: 'shell.pages.guides', path: '/guides', icon: BookOpen },
]

const cleanPath = () => route.path.replace(/\/$/, '') || '/'
const matches = (path: string) => {
  const current = cleanPath()
  return path === '/' ? current === '/' : current === path || current.startsWith(path + '/')
}

export const isActive = (path: string, also: readonly string[] = []) => matches(path) || also.some(matches)

/** Resolve child selection without marking the whole group as the current page. */
export function isNavActive(item: NavItem): boolean {
  if (item.section) return cleanPath() === '/connect' && apiSectionLocation.current === item.section
  if (item.webhookView) {
    const history = route.path.startsWith('/webhooks/deliveries/') || route.query.get('tab') === 'deliveries'
    return isActive('/webhooks') && (item.webhookView === 'deliveries' ? history : !history)
  }
  return isActive(item.path, item.also)
}

export function navPath(item: NavItem): string {
  if (!item.section || cleanPath() !== '/connect') return item.path
  const query = new URLSearchParams(route.query)
  query.set('section', item.section)
  return `/connect?${query}`
}
