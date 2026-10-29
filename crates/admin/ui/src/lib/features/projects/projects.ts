import type { ProjectLink, ProjectsData } from "$lib/contracts/types";
// Navigation between the panels of the host's projects.
import { api } from "$lib/transport/api";
import { ApiError } from "$lib/transport/api-error";

/**
 * Opens another project's panel. With single sign-on it carries a handoff
 * token (in the URL fragment, which never reaches logs); without it, the other
 * panel asks for its own login.
 */
export async function openProject(project: ProjectLink, sso: boolean) {
  if (project.current || project.url === null || project.url === "") return;
  if (sso) {
    const { url } = await api.post<{ url: string }>("/sso/handoff", { project: project.name });
    location.href = handoffDestination(url, project.url);
    return;
  }
  location.href = `${project.url.replace(/\/$/, "")}/admin/`;
}

/**
 * The handoff URL carries a sign-in token, so it must open the chosen
 * project's own panel: a URL on any other origin (a misconfigured proxy, a
 * mismatched version) is refused instead of followed.
 */
export function handoffDestination(url: string, projectUrl: string): string {
  const refused = new ApiError(`SSO handoff URL is not on the project's origin`, 0, {
    code: "invalid_response",
  });
  let target: URL;
  let project: URL;
  try {
    target = new URL(url);
    project = new URL(projectUrl);
  } catch {
    throw refused;
  }
  if (target.origin !== project.origin) throw refused;
  return target.href;
}

/** Handoff token in the fragment (`#sso=...`), removed from the URL right away. */
export function takeHandoffToken(): string | null {
  const match = location.hash.match(/^#sso=([\w.-]+)$/);
  if (match == null) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return match[1] ?? null;
}

/** Read the project catalog through its centrally validated panel contract. */
export function loadProjects(): Promise<ProjectsData> {
  return api.get<ProjectsData>("/projects");
}
export type { ProjectsData } from "$lib/contracts/types";
