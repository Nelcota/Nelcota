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
}

// Tables, SQL and Migrations: one pill, tabs inside its pages.
export const databaseTabs = [
  { path: '/tables', title: 'shell.pills.tables', icon: Rows3 },
  { path: '/sql', title: 'shell.pills.sql', icon: SquareTerminal },
  { path: '/migrations', title: 'shell.pills.migrations', icon: History },
] as const satisfies readonly { path: string; title: MessageKey; icon: Component }[]

// Main navigation groups, shared by the workspace sidebar and mobile menu.
// Sign-in settings live under Users; /connect, not /api, since /admin/api/* is
// the panel API.
export const navPills: NavItem[] = [
  { title: 'shell.pages.overview', pill: 'shell.pills.overview', path: '/', icon: House },
  { title: 'shell.pages.database', pill: 'shell.pills.database', path: '/tables', icon: Database, also: ['/sql', '/migrations'] },
  { title: 'shell.pages.storage', pill: 'shell.pills.storage', path: '/storage', icon: HardDrive },
  { title: 'shell.pages.users', pill: 'shell.pills.users', path: '/users', icon: Users, also: ['/sign-in'] },
  { title: 'shell.pages.policies', pill: 'shell.pills.policies', path: '/policies', icon: ShieldCheck },
  { title: 'shell.pages.webhooks', pill: 'shell.pills.webhooks', path: '/webhooks', icon: Webhook },
  { title: 'shell.pages.connect', pill: 'shell.pills.connect', path: '/connect', icon: Plug },
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
  { title: 'shell.pages.updates', path: '/updates', icon: History },
  { title: 'shell.pages.guides', path: '/guides', icon: BookOpen },
]

const matches = (path: string) => (path === '/' ? route.path === '/' : route.path === path || route.path.startsWith(path + '/'))

export const isActive = (path: string, also: readonly string[] = []) => matches(path) || also.some(matches)
