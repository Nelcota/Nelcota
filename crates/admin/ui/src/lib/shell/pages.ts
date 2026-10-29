import { match } from "$lib/navigation/route-match";
// The signed-in panel's pages: which code and props each route renders.
// authenticated-shell.svelte renders from this table and the startup prefetch
// (prefetch.ts) downloads from it, so the two cannot drift apart.
import type { Component } from "svelte";

// Each page declares its own props; the table only carries them through
// (`never` accepts any page component; the shell renders it with `props`).
type PageModule = { default: Component<never> };
type PageLoader = () => Promise<PageModule>;

type PageRoute = {
  /** Props for the page when `path` is this route, else null. */
  readonly props: (path: string) => Record<string, unknown> | null;
  readonly load: PageLoader;
};

export type Page = {
  readonly load: PageLoader;
  readonly props: Record<string, unknown>;
  /** Remount key: a table's data and structure views share one editor. */
  readonly key: string;
};

const exactly = (route: string) => (path: string) => (path === route ? {} : null);

// First match wins, so the order matters.
const routes: PageRoute[] = [
  { props: exactly("/updates"), load: () => import("$lib/features/updates/updates.svelte") },
  { props: exactly("/"), load: () => import("$lib/features/overview/overview.svelte") },
  {
    props: (path) => {
      if (path === "/tables") return { name: undefined, view: "data" };
      const structure = match("/tables/:name/structure", path);
      if (structure !== null) return { name: structure.name, view: "structure" };
      const data = match("/tables/:name", path);
      return data === null ? null : { name: data.name, view: "data" };
    },
    load: () => import("$lib/features/tables/table-editor.svelte"),
  },
  { props: exactly("/sql"), load: () => import("$lib/features/sql/sql-editor.svelte") },
  {
    props: exactly("/migrations"),
    load: () => import("$lib/features/migrations/migrations.svelte"),
  },
  { props: exactly("/users"), load: () => import("$lib/features/users/users.svelte") },
  { props: exactly("/sign-in"), load: () => import("$lib/features/sign-in/sign-in.svelte") },
  { props: exactly("/storage"), load: () => import("$lib/features/storage/storage.svelte") },
  {
    props: (path) => match("/storage/:bucket", path),
    load: () => import("$lib/features/storage/storage-bucket.svelte"),
  },
  { props: exactly("/policies"), load: () => import("$lib/features/policies/policies.svelte") },
  { props: exactly("/webhooks"), load: () => import("$lib/features/webhooks/webhooks.svelte") },
  {
    props: (path) => match("/webhooks/deliveries/:id", path),
    load: () => import("$lib/features/webhooks/delivery-detail.svelte"),
  },
  { props: exactly("/projects"), load: () => import("$lib/features/projects/projects.svelte") },
  { props: exactly("/connect"), load: () => import("$lib/features/api/api-page.svelte") },
  {
    props: (path) => (path === "/guides" || match("/guides/:id", path) !== null ? {} : null),
    load: () => import("$lib/features/guides/guides.svelte"),
  },
];

// One request per page module: the shell re-reads the page on every path
// change (a table's two views), and must get the same promise back so its
// {#await} does not remount the page. A failed download is forgotten, so the
// next visit tries again.
const modules = new Map<PageLoader, Promise<PageModule>>();

export function loadPage(load: PageLoader): Promise<PageModule> {
  const cached = modules.get(load);
  if (cached !== undefined) return cached;
  const loading = load();
  modules.set(load, loading);
  loading.catch(() => modules.delete(load));
  return loading;
}

/** The page at `routePath` (a router path, without /admin), or null when there is none. */
export function pageFor(routePath: string): Page | null {
  const trimmed = routePath.replace(/\/$/, "");
  const path = trimmed === "" ? "/" : trimmed;
  for (const route of routes) {
    const props = route.props(path);
    if (props === null) continue;
    // Only the table editor takes a `name`.
    const name = typeof props.name === "string" ? props.name : null;
    const key = name === null ? routePath : `/tables/${name}`;
    return { load: route.load, props, key };
  }
  return null;
}
