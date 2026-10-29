import type { MessageKey } from "$lib/i18n/index.svelte";
import { apiSectionLocation } from "$lib/navigation/api-sections.svelte";
import { route } from "$lib/navigation/router.svelte";
import {
  CircleArrowUp as ArrowUpCircle,
  BookOpen,
  Boxes,
  CircleAlert,
  CodeXml,
  Database,
  Eye,
  Globe,
  HardDrive,
  RotateCcwClock as History,
  House,
  KeyRound,
  LogIn,
  Package,
  Plug,
  Rows3,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  SquareTerminal,
  UserRound,
  Users,
  Webhook,
} from "@lucide/svelte";
import type { Component } from "svelte";

import { requiredValue } from "../contracts/required-value.js";

/** Titles are translation keys: render them with `t(item.title)`. */
export type NavItem = {
  title: MessageKey;
  /** Rótulo curto para a barra lateral, quando o título da página não cabe nela. */
  label?: MessageKey;
  path: string;
  icon: Component;
  /** Other pages this item stays active for (sub-pages reached from it). */
  also?: string[];
  children?: readonly NavItem[];
  section?: string;
  /** List filter kept in `?filter=`; the item is selected only on that page with that filter. */
  filter?: string;
  webhookView?: "configuration" | "deliveries";
};

const databasePages = [
  {
    path: "/tables",
    title: "shell.pages.tables",
    icon: Rows3,
    children: [
      { path: "/tables", title: "tables.home.filters.all", icon: Rows3, filter: "all" },
      {
        path: "/tables?filter=attention",
        title: "tables.home.filters.attention",
        label: "shell.nav.short.attention",
        icon: CircleAlert,
        filter: "attention",
      },
      {
        path: "/tables?filter=views",
        title: "tables.home.filters.views",
        icon: Eye,
        filter: "views",
      },
    ],
  },
  { path: "/sql", title: "shell.pages.sql", icon: SquareTerminal },
  { path: "/migrations", title: "shell.pages.migrations", icon: History },
] as const satisfies readonly NavItem[];

export const apiSectionPages = (
  [
    {
      section: "api-address",
      title: "connect.address",
      label: "connect.short.address",
      icon: Globe,
    },
    {
      section: "api-roles",
      title: "connect.caller",
      label: "connect.short.caller",
      icon: UserRound,
    },
    { section: "api-sdk", title: "connect.sdk.title", label: "connect.short.sdk", icon: Package },
    { section: "api-ai", title: "connect.ai.title", label: "connect.short.ai", icon: Sparkles },
    {
      section: "api-examples",
      title: "connect.examples",
      label: "connect.short.examples",
      icon: CodeXml,
    },
    {
      section: "api-token",
      title: "connect.token.title",
      label: "connect.short.token",
      icon: KeyRound,
    },
  ] as const
).map(({ section, title, label, icon }) => ({
  section,
  title,
  label,
  icon,
  path: `/connect?section=${section}`,
})) satisfies NavItem[];

// Main navigation groups, shared by the workspace sidebar and mobile menu.
// Sign-in settings live under Users; /connect, not /api, since /admin/api/* is
// the panel API.
export const navPills: NavItem[] = [
  { title: "shell.pages.overview", path: "/", icon: House },
  {
    title: "shell.pages.database",
    path: "/tables",
    icon: Database,
    also: ["/sql", "/migrations"],
    children: databasePages,
  },
  { title: "shell.pages.storage", path: "/storage", icon: HardDrive },
  {
    title: "shell.pages.users",
    path: "/users",
    icon: Users,
    also: ["/sign-in"],
    children: [
      { title: "shell.nav.userList", path: "/users", icon: Users },
      {
        title: "shell.pages.userSignIn",
        label: "shell.nav.short.signIn",
        path: "/sign-in",
        icon: LogIn,
      },
    ],
  },
  {
    title: "shell.pages.policies",
    label: "shell.nav.short.policies",
    path: "/policies",
    icon: ShieldCheck,
    children: [
      { title: "policies.filters.all", path: "/policies", icon: Rows3, filter: "all" },
      {
        title: "policies.filters.enabled",
        path: "/policies?filter=enabled",
        icon: ShieldCheck,
        filter: "enabled",
      },
      {
        title: "policies.filters.disabled",
        path: "/policies?filter=disabled",
        icon: ShieldOff,
        filter: "disabled",
      },
      {
        title: "policies.filters.attention",
        label: "shell.nav.short.attention",
        path: "/policies?filter=attention",
        icon: CircleAlert,
        filter: "attention",
      },
    ],
  },
  {
    title: "shell.pages.webhooks",
    label: "shell.nav.short.webhooks",
    path: "/webhooks",
    icon: Webhook,
    children: [
      {
        title: "webhooks.configuration",
        label: "shell.nav.short.webhookConfig",
        path: "/webhooks",
        icon: Webhook,
        webhookView: "configuration",
      },
      {
        title: "webhooks.deliveries",
        label: "shell.nav.short.deliveries",
        path: "/webhooks?tab=deliveries",
        icon: History,
        webhookView: "deliveries",
      },
    ],
  },
  { title: "shell.pages.connect", path: "/connect", icon: Plug, children: apiSectionPages },
];

// Every page the command palette can open: the groups, plus pages reached
// from inside them (sign-in from Users, projects from the project switcher).
export const navItems: NavItem[] = [
  requiredValue(navPills[0], "bounded operation item"),
  { title: "shell.pages.tables", path: "/tables", icon: Rows3 },
  { title: "shell.pages.sql", path: "/sql", icon: SquareTerminal },
  { title: "shell.pages.migrations", path: "/migrations", icon: History },
  ...navPills.slice(2),
  { title: "shell.pages.userSignIn", path: "/sign-in", icon: LogIn },
  { title: "shell.pages.projects", path: "/projects", icon: Boxes },
  { title: "shell.pages.updates", path: "/updates", icon: ArrowUpCircle },
  { title: "shell.pages.guides", path: "/guides", icon: BookOpen },
];

const cleanPath = () => {
  const trimmed = route.path.replace(/\/$/, "");
  return trimmed === "" ? "/" : trimmed;
};
const matches = (path: string) => {
  const current = cleanPath();
  return path === "/" ? current === "/" : current === path || current.startsWith(path + "/");
};

export const isActive = (path: string, also: readonly string[] = []) =>
  matches(path) || also.some(matches);

/** O texto da barra lateral: o rótulo curto quando existe, senão o título da página. */
export const navLabel = (item: NavItem): MessageKey => item.label ?? item.title;

/** Resolve child selection without marking the whole group as the current page. */
export function isNavActive(item: NavItem): boolean {
  if (item.filter != null && item.filter !== "") {
    return filteredNavActive(item);
  }
  if (item.section != null && item.section !== "")
    return cleanPath() === "/connect" && apiSectionLocation.current === item.section;
  if (item.webhookView != null) {
    const history =
      route.path.startsWith("/webhooks/deliveries/") || route.query.get("tab") === "deliveries";
    return (
      isActive("/webhooks") &&
      (item.webhookView === "deliveries" ? history : Boolean(history) === false)
    );
  }
  return isActive(item.path, item.also);
}

function filteredNavActive(item: NavItem): boolean {
  const filter = route.query.get("filter");
  const known = hasFilter(navPills, cleanPath(), filter);
  return cleanPath() === pathOf(item) && (known ? filter : "all") === item.filter;
}

const pathOf = (item: NavItem) => item.path.split("?")[0] ?? "";

function hasFilter(items: readonly NavItem[], path: string, filter: string | null): boolean {
  return items.some(
    (item) =>
      (item.filter === filter && pathOf(item) === path) ||
      (item.children != null ? hasFilter(item.children, path, filter) : false),
  );
}

export function navPath(item: NavItem): string {
  if (item.filter != null && item.filter !== "" && cleanPath() === pathOf(item))
    return filterPath(item, item.filter);
  if (item.section == null || item.section === "" || cleanPath() !== "/connect") return item.path;
  const query = new URLSearchParams(route.query);
  query.set("section", item.section);
  return `/connect?${query}`;
}

// Changing the filter keeps the search typed on the page (`?q=`).
function filterPath(item: NavItem, filter: string): string {
  const query = new URLSearchParams(route.query);
  query.delete("filter");
  if (filter !== "all") query.set("filter", filter);
  return query.size > 0 ? `${pathOf(item)}?${query}` : pathOf(item);
}
