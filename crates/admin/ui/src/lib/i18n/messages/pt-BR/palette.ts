// Command palette (Ctrl/⌘ K). The `keywords` prefix each item's search text,
// so typing "table" or "tabela" finds tables in the matching language.
const ptBR = {
  title: 'Paleta de comandos',
  description: 'Busque páginas, tabelas, consultas e ações',
  placeholder: 'Buscar páginas, tabelas, consultas…',
  empty: 'Nada encontrado. Tente outro nome de página, tabela ou consulta.',
  view: 'view',
  hints: { move: 'navegar', open: 'abrir', close: 'fechar' },
  groups: {
    pages: 'Páginas',
    tables: 'Tabelas',
    saved: 'Consultas salvas',
    templates: 'Modelos SQL',
    actions: 'Ações',
  },
  keywords: {
    page: 'página',
    table: 'tabela',
    query: 'consulta',
    template: 'modelo',
  },
  actions: {
    theme: 'Alternar tema',
    themeKeywords: 'ação alternar tema claro escuro',
    docs: 'Abrir documentação da API',
    docsKeywords: 'ação documentação api openapi',
    signOut: 'Sair',
    signOutKeywords: 'ação sair logout',
  },
}

export default ptBR
