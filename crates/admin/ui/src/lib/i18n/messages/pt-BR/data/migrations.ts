// Migrations page: panel changes still outside migrations and the migration list.
const ptBR = {
  upload: {
    title: "Apply repository migrations",
    description:
      "Select the complete migrations folder, including already applied files. Preview checks history without changing data. Each pending file commits separately; keep a verified backup before production deployment.",
    files: "Migration SQL files",
    preview: "Preview migrations",
    apply: "Apply migrations",
  },
  result: {
    fileBudget:
      "Select at most 1,024 SQL files; their complete encoded request must fit within 2 MiB.",
    previewFirst:
      "Preview the complete folder before applying. Selecting different files requires a new preview.",
    working: "Checking migration history and preparing the result\u2026",
    applying:
      "Preparing the verified backup and applying migrations. Keep this page open; this can take several minutes.",
    previewResult: "Preview only: no migrations were applied.",
    applyResult: "Newly applied migrations: {count}.",
    noChanges: "No pending files to apply.",
    catalogPending:
      "SQL committed, but the API schema refresh is still pending. Refresh status; do not replay the migration.",
    backup: "Verified recovery backup: {backup}",
    afterApply:
      "Regenerate database.ts, test your application and keep the backup with its paired files.",
    uncertain:
      "Some earlier files may already have committed. Preview the complete folder to reconcile history before applying again.",
    history: "Migration status",
    version: "Version",
    name: "Name",
    state: "State",
    applied: "Applied",
    pending: "Pending",
    diverged: "Changed or out of order",
    missing: "Missing from selected files",
    backupHelp: "Configure automatic migration backups",
    deployment: "Prepare deployment",
  },
  title: "Migrações",
  summary: {
    pending: { one: "{count} alteração pendente", other: "{count} alterações pendentes" },
    applied: { one: "{count} migração aplicada", other: "{count} migrações aplicadas" },
  },
  timeline: "Linha do tempo das migrações",
  next: "Próxima migração",
  nextPending: {
    one: "{count} alteração do painel ainda sem arquivo",
    other: "{count} alterações do painel ainda sem arquivo",
  },
  appliedOn: "Aplicada em {date}",
  steps: {
    title: "Como levar a outros ambientes",
    label: "Etapas para levar as mudanças a outros ambientes",
    generate: "Gerar arquivo",
    generateHint: "Exporte as alterações do painel em uma migração SQL.",
    keep: "Salvar e versionar",
    keepHint: "Coloque o arquivo em migrations/ e faça commit no projeto.",
    apply: "Aplicar nos outros ambientes",
    applyHint:
      "Execute nelcota migrate em cada ambiente. Neste banco, as mudanças do painel já estão aplicadas.",
    inFolder: "Arquivo encontrado na pasta",
    pending: "Aguardando arquivo na pasta",
  },
  description: "Guarde as mudanças do banco em arquivos para aplicar em outros ambientes.",
  generate: "Gerar migração",
  generatedBefore: "foi baixada. Coloque em",
  generatedMiddle: "e faça commit: neste banco ela já consta como aplicada, e o",
  generatedAfter: "aplica nos outros ambientes.",
  generatedToast: "{filename} gerada",
  nothingPending: "Nada pendente",
  nothingPendingHint: "O que você mudar pelo painel aparece aqui até ser exportado como migração.",
  statements: { one: "SQL ({count} comando)", other: "SQL ({count} comandos)" },
  // One per `kind` recorded by the server (panel_changes.kind).
  changes: {
    table_created: "Tabela {name} criada",
    table_altered: "Tabela {name} alterada",
    table_dropped: "Tabela {name} apagada",
    policy_created: "Política {name} criada",
    policy_updated: "Política {name} atualizada",
    policy_dropped: "Política {name} apagada",
  },
  noMigrations: "Nenhuma migração ainda",
  noMigrationsHint:
    "Arquivos V1__nome.sql em migrations/, aplicados com nelcota migrate, aparecem aqui.",
  fromPanel: "gerada pelo painel",
  status: {
    notApplied: "Não aplicada neste banco",
    outsideFolder: "arquivo não está na pasta",
  },
  folderRead: "Pasta lida:",
  folderMissing:
    "A pasta migrations/ não está acessível a este servidor: a numeração considera só o banco.",
  dialog: {
    description: {
      one: "Junta a {count} alteração pendente num arquivo e o registra como aplicado neste banco.",
      other:
        "Junta as {count} alterações pendentes num arquivo e o registra como aplicado neste banco.",
    },
    defaultName: "alteracoes_do_painel",
    file: "Arquivo:",
    nameRule: "Letras minúsculas, números e _ (ex.: criar_pedidos).",
    generating: "Gerando…",
    submit: "Gerar e baixar",
  },
};

export default ptBR;
