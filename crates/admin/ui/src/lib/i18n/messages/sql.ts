// SQL editor: toolbar, results, saved queries and ready-made templates.
import type { Messages } from '../index.svelte'

const ptBR = {
  editor: {
    newQuery: 'Nova consulta',
    unsaved: '(não salva)',
    unsavedTitle: 'Alterações não salvas',
    ownerNote: 'Acesso total',
    ownerNoteMore: ' · ignora as regras',
    ownerNoteTitle: 'As consultas rodam como dono do banco: as políticas de acesso (RLS) não se aplicam e tudo pode ser lido e alterado.',
    renameHint: 'Clique para renomear',
    saveHint: 'Clique para salvar com um nome',
    runSelection: 'Executar seleção',
    errorHere: 'Destacado no editor, linha {line}.',
    open: 'Consultas e modelos',
    drafts: 'Rascunhos',
    localOnly: 'Consultas e rascunhos ficam neste navegador, para este projeto.',
    resize: 'Redimensionar editor e resultados',
    discardDraft: 'Este rascunho será removido deste navegador. Não dá para desfazer.',
    saved: 'Salvas',
    templates: 'Modelos',
    history: 'Histórico',
    recentlyRun: 'Executadas recentemente',
    saveMore: 'Mais opções de salvar',
    saveAsNew: 'Salvar como nova…',
    rename: 'Renomear…',
    run: 'Executar',
    runTitle: 'Executar ({shortcut})',
    running: 'Executando…',
    stop: 'Parar',
    stopTitle: 'Interromper a consulta em execução',
    stoppedToast: 'Consulta interrompida.',
    savedToast: '"{name}" salva',
    exportBaseName: 'resultado',
  },
  results: {
    label: 'Resultados da consulta SQL',
    completed: 'Consulta concluída em {ms} ms.',
    emptyTitle: 'Nenhum resultado ainda',
    emptyDescription: 'Escreva uma consulta e execute.',
    position: 'Posição {position} no texto.',
    hint: 'Dica: {hint}',
    noRows: 'Executado, sem linhas',
    noMatchingRows: 'A consulta rodou, mas nenhuma linha atende às condições.',
    failed: 'A consulta falhou',
    resultOf: 'Resultado {index} de {total}',
    rows: { one: '{count} linha', other: '{count} linhas' },
    truncated: '(resultado limitado por linhas ou tamanho)',
    batchTruncated: 'Exibindo os primeiros 32 resultados. Todos os comandos do lote foram processados.',
  },
  dialog: {
    saveTitle: 'Salvar consulta',
    renameTitle: 'Renomear consulta',
    renameConfirm: 'Renomear',
    description: 'Fica salva neste navegador, para este projeto.',
    placeholder: 'ex.: pedidos da semana',
    deleteTitle: 'Apagar "{name}"?',
    deleteDescription: 'A consulta salva some deste navegador. Não dá para desfazer.',
  },
  sidebar: {
    label: 'Consultas salvas e modelos',
    title: 'Editor SQL',
    savedCount: 'Salvas ({count})',
    noSaved: 'Nenhuma consulta salva.',
    localOnly: 'Guardadas neste navegador',
    actionsFor: 'Ações de {name}',
    discardDraft: 'Descartar o rascunho {name}',
    rename: 'Renomear',
  },
  title: {
    read: 'Consulta em {target}',
    insert: 'Inserir em {target}',
    update: 'Atualizar {target}',
    delete: 'Apagar de {target}',
    create: 'Criar {target}',
    alter: 'Alterar {target}',
    drop: 'Remover {target}',
    empty: 'Consulta vazia',
  },
  runAs: {
    label: 'Executar como',
    owner: 'Dono do banco',
    ownerHint: 'Acesso total: ignora as regras de acesso',
    anon: 'Visitante',
    anonHint: 'Sem login: o que qualquer pessoa vê pela API',
    authenticated: 'Usuário logado…',
    authenticatedHint: 'O que um usuário específico vê pela API',
    asVisitor: 'Como visitante',
    asUser: 'Como {email}',
    pickTitle: 'Executar como qual usuário?',
    search: 'Buscar por email',
    empty: 'Nenhum usuário encontrado',
    noUsers: 'Ainda não há usuários. Crie um para testar como ele.',
    loading: 'Carregando…',
  },
  status: {
    position: 'Linha {line}, coluna {column}',
    selected: { one: '{count} caractere selecionado', other: '{count} caracteres selecionados' },
    run: '{shortcut} executa',
    runSelection: '{shortcut} executa a seleção',
    limits: 'Limite de 30 s e 1000 linhas por resultado',
  },
  snippets: {
    rlsTable: {
      label: 'Criar tabela com RLS',
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
      label: 'Listar tabelas sem RLS',
      sql: `select c.relname as tabela, c.relrowsecurity as rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity, c.relname;`,
    },
    recentUsers: {
      label: 'Usuários recentes',
      sql: `select id, email, created_at, last_sign_in_at
from auth.users
order by created_at desc
limit 20;`,
    },
    slowQueries: {
      label: 'Consultas mais lentas',
      sql: `select round(mean_exec_time::numeric, 2) as ms_medio, calls, query
from extensions.pg_stat_statements
order by mean_exec_time desc
limit 20;`,
    },
  },
}

const en: Messages<typeof ptBR> = {
  editor: {
    newQuery: 'New query',
    unsaved: '(unsaved)',
    unsavedTitle: 'Unsaved changes',
    ownerNote: 'Full access',
    ownerNoteMore: ' · bypasses the rules',
    ownerNoteTitle: 'Queries run as the database owner: access policies (RLS) do not apply and everything can be read and changed.',
    renameHint: 'Click to rename',
    saveHint: 'Click to save with a name',
    runSelection: 'Run selection',
    errorHere: 'Highlighted in the editor, line {line}.',
    open: 'Queries and templates',
    drafts: 'Drafts',
    localOnly: 'Queries and drafts are stored in this browser, for this project.',
    resize: 'Resize editor and results',
    discardDraft: 'This draft will be removed from this browser. This cannot be undone.',
    saved: 'Saved',
    templates: 'Templates',
    history: 'History',
    recentlyRun: 'Recently run',
    saveMore: 'More save options',
    saveAsNew: 'Save as new…',
    rename: 'Rename…',
    run: 'Run',
    runTitle: 'Run ({shortcut})',
    running: 'Running…',
    stop: 'Stop',
    stopTitle: 'Stop the running query',
    stoppedToast: 'Query stopped.',
    savedToast: '"{name}" saved',
    exportBaseName: 'result',
  },
  results: {
    label: 'SQL query results',
    completed: 'Query completed in {ms} ms.',
    emptyTitle: 'No results yet',
    emptyDescription: 'Write a query and run it.',
    position: 'Position {position} in the text.',
    hint: 'Hint: {hint}',
    noRows: 'Done, no rows',
    noMatchingRows: 'The query ran, but no row matched.',
    failed: 'The query failed',
    resultOf: 'Result {index} of {total}',
    rows: { one: '{count} row', other: '{count} rows' },
    truncated: '(result limited by rows or size)',
    batchTruncated: 'Showing the first 32 results. All statements in the batch were processed.',
  },
  dialog: {
    saveTitle: 'Save query',
    renameTitle: 'Rename query',
    renameConfirm: 'Rename',
    description: 'Saved in this browser, for this project.',
    placeholder: 'e.g. orders this week',
    deleteTitle: 'Delete "{name}"?',
    deleteDescription: 'The saved query is removed from this browser. This cannot be undone.',
  },
  sidebar: {
    label: 'Saved queries and templates',
    title: 'SQL editor',
    savedCount: 'Saved ({count})',
    noSaved: 'No saved queries.',
    localOnly: 'Kept in this browser',
    actionsFor: 'Actions for {name}',
    discardDraft: 'Discard the draft {name}',
    rename: 'Rename',
  },
  title: {
    read: 'Query on {target}',
    insert: 'Insert into {target}',
    update: 'Update {target}',
    delete: 'Delete from {target}',
    create: 'Create {target}',
    alter: 'Alter {target}',
    drop: 'Drop {target}',
    empty: 'Empty query',
  },
  runAs: {
    label: 'Run as',
    owner: 'Database owner',
    ownerHint: 'Full access: bypasses the access rules',
    anon: 'Visitor',
    anonHint: 'No sign-in: what anyone sees through the API',
    authenticated: 'Signed-in user…',
    authenticatedHint: 'What a specific user sees through the API',
    asVisitor: 'As a visitor',
    asUser: 'As {email}',
    pickTitle: 'Run as which user?',
    search: 'Search by email',
    empty: 'No users found',
    noUsers: 'No users yet. Create one to test as them.',
    loading: 'Loading…',
  },
  status: {
    position: 'Line {line}, column {column}',
    selected: { one: '{count} character selected', other: '{count} characters selected' },
    run: '{shortcut} runs',
    runSelection: '{shortcut} runs the selection',
    limits: 'Limit of 30 s and 1000 rows per result',
  },
  snippets: {
    rlsTable: {
      label: 'Create a table with RLS',
      sql: `create table public.notes (
  id bigint generated always as identity primary key,
  owner uuid not null default auth.uid(),
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.notes enable row level security;

create policy "owner reads and changes their own notes"
  on public.notes for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

grant select, insert, update, delete on public.notes to authenticated;`,
    },
    tablesWithoutRls: {
      label: 'List tables without RLS',
      sql: `select c.relname as table_name, c.relrowsecurity as rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relrowsecurity, c.relname;`,
    },
    recentUsers: {
      label: 'Recent users',
      sql: `select id, email, created_at, last_sign_in_at
from auth.users
order by created_at desc
limit 20;`,
    },
    slowQueries: {
      label: 'Slowest queries',
      sql: `select round(mean_exec_time::numeric, 2) as mean_ms, calls, query
from extensions.pg_stat_statements
order by mean_exec_time desc
limit 20;`,
    },
  },
}

export default { 'pt-BR': ptBR, en }
