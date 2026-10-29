// Policies page, policy sheet, RLS badge, grants editor and SQL preview.
const ptBR = {
  previewAccess: "Preview as visitor",
  previewAccessHint:
    "Starts a read-only visitor preview. Use View as to select a user and compare allowed and denied rows; the administrator view bypasses RLS.",
  title: "Políticas de acesso",
  search: "Buscar tabela",
  filters: {
    all: "Todas",
    enabled: "Protegidas",
    disabled: "Sem proteção",
    attention: "Precisam de atenção",
  },
  filterEmpty: {
    enabled: {
      title: "Nenhuma tabela protegida",
      text: "Ative a proteção numa tabela para que só as regras decidam quem acessa.",
    },
    disabled: {
      title: "Todas as tabelas estão protegidas",
      text: "Nenhuma tabela fica aberta para a API sem regras.",
    },
    attention: {
      title: "Nada precisa de atenção",
      text: "Nenhuma tabela está desprotegida ou bloqueada sem regras.",
    },
  },
  showAll: "Ver todas as tabelas",
  summary: {
    protected: {
      one: "{protected} de {count} tabela protegida",
      other: "{protected} de {count} tabelas protegidas",
    },
  },
  attention: {
    title: { one: "{count} item precisa de atenção", other: "{count} itens precisam de atenção" },
    hint: "Resolva estes itens para que só as regras decidam quem acessa os dados.",
    unprotected: "Sem proteção: qualquer pessoa com o endereço da API lê e altera todas as linhas.",
    noRules: "Protegida, mas sem regras: ninguém acessa pela API até você criar uma.",
    createRule: "Criar regra",
  },
  tables: "Tabelas",
  count: { one: "{count} regra de acesso", other: "{count} regras de acesso" },
  description: "Quem pode ver e alterar os dados de cada tabela.",
  legend: {
    title: "Como ler a proteção de cada tabela",
    intro:
      "Cada regra de acesso é uma policy do Postgres. Elas só valem com a proteção por linha (RLS) ativa na tabela.",
  },
  exposedRelations:
    "Revise {relations} no editor SQL. Views usam os privilégios do dono: configure security_invoker = true e verifique as políticas das tabelas de origem, ou remova o GRANT. Views materializadas e tabelas externas precisam de controle de acesso próprio.",
  ownerView: "Privilégios do dono",
  reviewSql: "Abrir editor SQL",
  ownerViewHint:
    "Esta view usa os privilégios do dono e pode ignorar o RLS do usuário. Revise security_invoker = true ou remova o GRANT.",
  noTables: "Nenhuma tabela",
  noTablesHint: "Crie uma tabela para definir regras de acesso nela.",
  enableRls: "Ativar proteção por linha (RLS)",
  enableRlsEmpty: {
    title: "Ativar a proteção de {table}?",
    description:
      "A tabela ainda não tem nenhuma regra de acesso. Com a proteção ativa, visitantes (anon) e usuários logados (authenticated) deixam de ver qualquer linha pela API (as consultas voltam vazias) até você criar uma regra. Só o seu backend (service_role) continua com acesso.",
    confirm: "Ativar mesmo assim",
  },
  newPolicy: "Nova regra",
  noPolicies: "Nenhuma regra.",
  noPoliciesRlsBefore: "Nenhuma regra: ninguém acessa pela API, só o seu backend (",
  noPoliciesRlsAfter: "). Crie uma regra de acesso para liberar.",
  restrictiveTag: "(restritiva)",
  editLabel: "Editar {name}",
  customRoles: "Esta regra usa um papel criado no SQL: edite pelo editor SQL.",
  deleteLabel: "Apagar {name}",
  blocked: {
    title: "Bloqueios recentes",
    hint: "As últimas {capacity} chamadas que a API recusou, guardadas só até o servidor reiniciar.",
    hintMore: "Leituras que as regras filtram não aparecem aqui: voltam vazias, não recusadas.",
    updated: "Atualizado às {time}",
    none: "Nenhuma chamada recusada desde que o servidor iniciou.",
    refresh: "Atualizar",
    showAll: { one: "Ver {count} bloqueio", other: "Ver os {count} bloqueios" },
    showLess: "Ver menos",
    who: {
      anon: "Visitante",
      invalid_token: "Token inválido",
      service_role: "Seu backend (service_role)",
      authenticated: "Usuário logado",
    },
    target: { table: "tabela {name}", function: "função {name}", bucket: "bucket {name}" },
    reasons: {
      token:
        "O token enviado expirou ou é inválido. O SDK renova sozinho; com fetch, a pessoa precisa entrar de novo.",
      rateLimited: "Muitas tentativas seguidas: a API pediu para esperar.",
      files:
        "Nenhuma regra de acesso deste bucket permite isso. As regras ficam na página do bucket, em Armazenamento.",
      rls: "Uma regra de acesso recusou esta escrita: a linha nova ou alterada não cumpre a condição das regras (WITH CHECK).",
      grantAnon:
        "Visitantes (anon) não têm permissão (GRANT) para isto. Libere na aba Estrutura da tabela, se for a intenção.",
      grantUser:
        "Usuários logados (authenticated) não têm permissão (GRANT) para isto. Libere na aba Estrutura da tabela, se for a intenção.",
      other: "Recusada pela API.",
    },
  },
  anonFunctions: "Funções que visitantes (anon) podem executar",
  anonFunctionsHint:
    "Por padrão, o Postgres deixa qualquer um executar uma função nova (EXECUTE para PUBLIC). Para restringir:",
  rlsEnabled: "Proteção ativada em {table}",
  deleted: 'Regra "{name}" apagada',
  confirmDelete: {
    title: 'Apagar a regra "{name}"?',
    description: "As linhas de {table} que só ela liberava deixam de ser acessíveis.",
    confirm: "Apagar regra",
  },
  sheet: {
    new: "Nova regra de acesso",
    edit: "Editar regra de acesso",
    onTable: "na tabela",
    fromTemplate: "Começar de um modelo",
    templatesOwnerColumn: "Modelos de dono usam a coluna",
    name: "Nome",
    namePlaceholder: "ex.: dono lê as próprias notas",
    command: "Comando",
    appliesTo: "Vale para",
    noRoles: "Nenhuma marcada: vale para todos (PUBLIC).",
    restrictive: "Restritiva",
    restrictiveHint:
      "Regras permissivas somam acesso (basta uma liberar). Restritivas são exigidas além delas.",
    usingSees: "quais linhas existentes a role enxerga",
    usingDeletes: "quais linhas existentes a role pode apagar",
    checkHint: "quais linhas novas ou alteradas são aceitas",
    checkPlaceholder: "vazio = mesma regra do USING",
    helpBefore: "Use",
    helpMiddle: "para o id do usuário logado e",
    helpAfter: "para as claims do token.",
    previewPlaceholder: "Dê um nome e escreva a expressão para ver o SQL.",
    savePolicy: "Salvar regra",
    createPolicy: "Criar regra",
    saved: 'Regra "{name}" salva',
    commands: {
      select: "SELECT (ler)",
      insert: "INSERT (criar)",
      update: "UPDATE (alterar)",
      delete: "DELETE (apagar)",
      all: "ALL (tudo)",
    },
    roles: {
      anon: "sem login",
      authenticated: "logados",
      service_role: "backend",
    },
  },
  rls: {
    none: "sem RLS",
    noPolicies: "RLS sem políticas",
    policies: { one: "RLS, {count} política", other: "RLS, {count} políticas" },
    noGrants: "sem RLS, sem grants",
    view: "view",
  },
  grants: {
    role: "Papel (role)",
    privilegeFor: "{privilege} para {role}",
    hints: {
      anon: "chamadas sem token",
      authenticated: "usuários logados",
      service_role: "seu backend (ignora RLS)",
    },
  },
  plain: {
    toggle: "Detalhes técnicos",
    toggleHint: "Mostra RLS, roles e o SQL de cada regra",
    state: {
      ok: "Protegida",
      warn: "Bloqueada",
      danger: "Desprotegida",
      none: "Fora da API",
      view: "View",
    },
    stateHint: {
      ok: "Só acessa quem as regras permitem.",
      warn: "A proteção está ativa, mas sem regras: ninguém acessa pela API.",
      danger: "Qualquer pessoa com o endereço da API pode ler e alterar todas as linhas.",
      none: "A API não tem permissão nesta tabela: só o seu backend acessa.",
      view: "Uma consulta salva (view): segue as regras das tabelas que ela lê.",
    },
    who: { anon: "Visitantes", authenticated: "Usuários logados" },
    access: {
      none: "Sem acesso",
      read: "Só leitura",
      full: "Leitura e escrita",
      partial: "Pode {verbs}",
    },
    verbs: { read: "ver", create: "criar", edit: "editar", delete: "apagar" },
    rule: {
      everyoneReads: "Qualquer pessoa pode ver as linhas",
      signedInReads: "Usuários logados podem ver as linhas",
      owner: {
        select: "Cada usuário só vê as próprias linhas",
        insert: "Cada usuário só cria linhas em seu próprio nome",
        update: "Cada usuário só edita as próprias linhas",
        delete: "Cada usuário só apaga as próprias linhas",
        all: "Cada usuário só vê e altera as próprias linhas",
      },
      ownerColumn: "dono na coluna {column}",
      custom: "Regra personalizada",
    },
  },
  sqlPreview: {
    title: "SQL que será executado",
    updating: "· atualizando…",
    copy: "Copiar SQL",
    copied: "SQL copiado",
    placeholder: "Preencha o formulário para ver o SQL.",
  },
};

export default ptBR;
