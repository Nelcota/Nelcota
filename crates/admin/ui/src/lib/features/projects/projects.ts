// Navigation between the panels of the host's projects.
import { api } from '$lib/transport/api'
import type { ProjectLink } from '$lib/contracts/types'

/**
 * Opens another project's panel. With single sign-on it carries a handoff
 * token (in the URL fragment, which never reaches logs); without it, the other
 * panel asks for its own login.
 */
export async function openProject(project: ProjectLink, sso: boolean) {
  if (project.current || !project.url) return
  if (sso) {
    const { url } = await api.post<{ url: string }>('/sso/handoff', { project: project.name })
    location.href = url
    return
  }
  location.href = `${project.url.replace(/\/$/, '')}/admin/`
}

/** Handoff token in the fragment (`#sso=...`), removed from the URL right away. */
export function takeHandoffToken(): string | null {
  const match = location.hash.match(/^#sso=([\w.-]+)$/)
  if (!match) return null
  history.replaceState(null, '', location.pathname + location.search)
  return match[1]
}
