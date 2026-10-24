export const guideGroups = ['start', 'develop', 'operate', 'internals'] as const
type Group = typeof guideGroups[number]

export const guides = [
  { id: 'sdk-start', group: 'start', source: 'sdk/typescript/docs/quickstart.pt-BR.md', language: 'pt-BR', action: '/connect', versionNotes: 1 },
  { id: 'quickstart', group: 'start', source: 'docs/quickstart.md', action: '/connect' },
  { id: 'panel', group: 'start', source: 'docs/panel.md', action: '/' },
  { id: 'sdk', group: 'develop', source: 'sdk/typescript/README.md', action: '/connect' },
  { id: 'api', group: 'develop', source: 'docs/api.md', action: '/connect' },
  { id: 'openapi', group: 'develop', source: '', action: '/policies' },
  { id: 'auth', group: 'develop', source: 'docs/schema-auth.md', action: '/sign-in' },
  { id: 'roles', group: 'develop', source: 'docs/jwt-and-roles.md', action: '/policies' },
  { id: 'storage', group: 'develop', source: 'docs/storage.md', action: '/storage' },
  { id: 'webhooks', group: 'develop', source: 'docs/webhooks.md', action: '/webhooks' },
  { id: 'sdk-rust', group: 'develop', source: 'sdk/rust/README.md', action: '/connect' },
  { id: 'rust-start', group: 'develop', source: 'sdk/rust/docs/quickstart.pt-BR.md', language: 'pt-BR', action: '/connect', versionNotes: 1 },
  { id: 'example', group: 'develop', source: 'examples/notes.sql', code: 'sql', action: '/sql' },
  { id: 'ssr', group: 'develop', source: 'sdk/typescript/examples/server.mjs', code: 'ts', action: '/connect' },
  { id: 'troubleshooting', group: 'operate', source: 'docs/troubleshooting.md', action: '/policies' },
  { id: 'deploy', group: 'operate', source: 'docs/deploy.md', action: '/migrations' },
  { id: 'backup', group: 'operate', source: 'docs/backup.md', action: '/storage' },
  { id: 'leaving', group: 'operate', source: 'docs/leaving.md', action: '/tables' },
  { id: 'sdk-contract', group: 'internals', source: 'sdk/typescript/docs/contract.md', action: '/connect' },
  { id: 'rust-contract', group: 'internals', source: 'sdk/rust/docs/contract.md', action: '/connect' },
  { id: 'sdk-releasing', group: 'internals', source: 'sdk/typescript/docs/releasing.md', action: '/connect' },
  { id: 'rust-releasing', group: 'internals', source: 'sdk/rust/docs/releasing.md', action: '/connect' },
  { id: 'changelog', group: 'internals', source: 'sdk/typescript/CHANGELOG.md', action: '/connect' },
  { id: 'architecture', group: 'internals', source: 'docs/architecture.md', action: '/' },
  { id: 'decisions', group: 'internals', source: 'docs/decisions.md', action: '/' },
] as const satisfies readonly {
  id: string
  group: Group
  source: string
  language?: string
  code?: string
  action: string
  /** Leading paragraphs that only describe the release: folded so the guide opens on its subject. */
  versionNotes?: number
}[]

export type Guide = typeof guides[number]
export type GuideId = Guide['id']

export const guidePath = (id: GuideId, section?: string) =>
  `/guides/${id}${section ? `?section=${encodeURIComponent(section)}` : ''}`
