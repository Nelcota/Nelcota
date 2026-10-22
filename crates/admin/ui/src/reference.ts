import { createApiReference, type ApiReferenceConfiguration } from '@scalar/api-reference'
import '@scalar/api-reference/style.css'
import { isOpenApiDocument } from './lib/features/guides/openapi'

// A separate document isolates Scalar's styles and hash navigation from the
// Svelte panel. Its scripts and styles are embedded and served by Rust.
let instance: ReturnType<typeof createApiReference> | undefined
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'nelcota:openapi') return
  const { document: content, dark, locale } = event.data
  if (!isOpenApiDocument(content)) return
  document.documentElement.lang = locale === 'pt-BR' ? 'pt-BR' : 'en'
  const config = {
    content: JSON.stringify(content), layout: 'modern' as const, showSidebar: true,
    darkMode: Boolean(dark), hideDarkModeToggle: true, withDefaultFonts: false,
    localization: { locale: locale === 'pt-BR' ? 'pt' : 'en' } satisfies NonNullable<ApiReferenceConfiguration['localization']>,
    telemetry: false, agent: { disabled: true }, proxyUrl: '', showDeveloperTools: 'never' as const,
    // On localhost Scalar offers "Generate SDKs & MCP": a sign-up dialog that
    // uploads the document to Scalar. The panel keeps everything on this
    // server (and its CSP blocks the upload), so hide the sidebar call to
    // action and the per-operation "Generate SDK" buttons, which have no option.
    mcp: { disabled: true },
    setPageTitle: () => 'Nelcota API',
    customCss: 'body { margin: 0; } .scalar-app { font-family: system-ui, sans-serif; }'
      + ' .generate-sdk-button, .selected-client-action { display: none !important; }',
  }
  if (instance) {
    instance.updateConfiguration(config)
    return
  }
  instance = createApiReference('#reference', config)
})
window.addEventListener('pagehide', () => instance?.destroy(), { once: true })
