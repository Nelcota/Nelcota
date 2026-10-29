import type { ProjectsData, ProjectStatus } from "$lib/contracts/types";
import { RemoteResource } from "$lib/resources/remote-resource.svelte";
import { api } from "$lib/transport/api";
export { openProject } from "./projects.js";
export type { ProjectStatus } from "$lib/contracts/types";

/** Loads inventory and health under one cancellation and publication boundary. */
export class ProjectCatalog extends RemoteResource<{ projects: ProjectStatus[]; sso: boolean }> {
  reload(): Promise<boolean> {
    return this.load(async (signal) => {
      const [list, status] = await Promise.all([
        api.get<ProjectsData>("/projects", { signal }),
        api.get<{ projects: ProjectStatus[] }>("/projects/status", { signal }),
      ]);
      return {
        sso: list.sso,
        projects:
          status.projects.length > 0
            ? status.projects
            : list.projects.map(({ name, url, current }) => ({
                name,
                url,
                current,
                healthy: true,
                version: null,
                latency_ms: null,
              })),
      };
    });
  }
}
