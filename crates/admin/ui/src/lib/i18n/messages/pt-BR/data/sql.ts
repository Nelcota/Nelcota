// SQL editor: toolbar, results, saved queries and ready-made templates.
const ptBR = {
  editor: {
    migrationWarning:
      "SQL editor changes are not recorded as application migrations. Keep schema changes in repository migration files before deploying other environments.",
    newQuery: "Nova consulta",
    unsaved: "· rascunho sem salvar",
    unsavedTitle: "Alterações não salvas",
    ownerNote: "Executar como: acesso total",
    ownerNoteMore: " · ignora as regras",
    ownerNoteTitle:
      "As consultas rodam como dono do banco: as políticas de acesso (RLS) não se aplicam e tudo pode ser lido e alterado.",
    renameHint: "Clique para renomear",
    saveHint: "Clique para salvar com um nome",
    runSelection: "Executar seleção",
    errorHere: "Destacado no editor, linha {line}.",
    open: "Consultas e modelos",
    drafts: "Rascunhos",
    localOnly: "Consultas e rascunhos ficam neste navegador, para este projeto.",
    resize: "Redimensionar editor e resultados",
    discardDraft: "Este rascunho será removido deste navegador. Não dá para desfazer.",
    saved: "Salvas",
    templates: "Modelos",
    history: "Histórico",
    recentlyRun: "Executadas recentemente",
    saveMore: "Mais opções de salvar",
    saveAsNew: "Salvar como nova…",
    rename: "Renomear…",
    run: "Executar",
    runTitle: "Executar ({shortcut})",
    running: "Executando…",
    stop: "Parar",
    stopTitle: "Interromper a consulta em execução",
    stoppedToast: "Consulta interrompida.",
    savedToast: '"{name}" salva',
    exportBaseName: "resultado",
  },
  results: {
    label: "Resultados da consulta SQL",
    completed: "Consulta concluída em {ms} ms.",
    emptyTitle: "Nenhum resultado ainda",
    emptyDescription: "Escreva uma consulta e execute.",
    position: "Posição {position} no texto.",
    hint: "Dica: {hint}",
    noRows: "Executado, sem linhas",
    noMatchingRows: "A consulta rodou, mas nenhuma linha atende às condições.",
    failed: "A consulta falhou",
    resultOf: "Resultado {index} de {total}",
    rows: { one: "{count} linha", other: "{count} linhas" },
    truncated: "(resultado limitado por linhas ou tamanho)",
    batchTruncated:
      "Exibindo os primeiros 32 resultados. Todos os comandos do lote foram processados.",
  },
  dialog: {
    saveTitle: "Salvar consulta",
    renameTitle: "Renomear consulta",
    renameConfirm: "Renomear",
    description: "Fica salva neste navegador, para este projeto.",
    placeholder: "ex.: pedidos da semana",
    deleteTitle: 'Apagar "{name}"?',
    deleteDescription: "A consulta salva some deste navegador. Não dá para desfazer.",
  },
  sidebar: {
    label: "Consultas salvas e modelos",
    title: "Editor SQL",
    savedCount: "Salvas ({count})",
    noSaved: "Nenhuma consulta salva.",
    localOnly: "Guardadas neste navegador",
    actionsFor: "Ações de {name}",
    discardDraft: "Descartar o rascunho {name}",
    rename: "Renomear",
  },
  title: {
    read: "Consulta em {target}",
    insert: "Inserir em {target}",
    update: "Atualizar {target}",
    delete: "Apagar de {target}",
    create: "Criar {target}",
    alter: "Alterar {target}",
    drop: "Remover {target}",
    empty: "Consulta vazia",
  },
  runAs: {
    label: "Executar como",
    owner: "Dono do banco",
    ownerHint: "Acesso total: ignora as regras de acesso",
    anon: "Visitante",
    anonHint: "Sem login: o que qualquer pessoa vê pela API",
    authenticated: "Usuário logado…",
    authenticatedHint: "O que um usuário específico vê pela API",
    asVisitor: "Como visitante",
    asUser: "Como {email}",
    pickTitle: "Executar como qual usuário?",
    search: "Buscar por e-mail",
    empty: "Nenhum usuário encontrado",
    noUsers: "Ainda não há usuários. Crie um para testar como ele.",
    loading: "Carregando…",
  },
  status: {
    position: "Linha {line}, coluna {column}",
    selected: { one: "{count} caractere selecionado", other: "{count} caracteres selecionados" },
    run: "{shortcut} executa",
    runSelection: "{shortcut} executa a seleção",
    limits: "Limite de 30 s e 1000 linhas por resultado",
  },
  snippets: {
    rlsTable: {
      label: "Criar tabela com RLS",
      sql: `create table public.notas (
  id bigint generated always as identity primary key,
  dono uuid not null default auth.uid(),
  texto text not null,
  criada_em timestamptz not null default now()
);

alter table public.notas enable row level security;

create policy "dono vê e altera as próprias notas"
  on public.notas for all to authenticated
  using (dono = auth.uid()) with check (dono = auth.uid());

grant select, insert, update, delete on public.notas to authenticated;`,
    },
    tablesWithoutRls: {
      label: "Listar tabelas sem RLS",
      sql: `select c.relname as tabela, c.relrowsecurity as rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity, c.relname;`,
    },
    recentUsers: {
      label: "Usuários recentes",
      sql: `select id, email, created_at, last_sign_in_at
from auth.users
order by created_at desc
limit 20;`,
    },
    slowQueries: {
      label: "Consultas mais lentas",
      sql: `select round(mean_exec_time::numeric, 2) as ms_medio, calls, query
from extensions.pg_stat_statements
order by mean_exec_time desc
limit 20;`,
    },
  },
};

export default ptBR;
