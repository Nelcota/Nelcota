// API page: endpoints, roles, service_role token and code examples.
const ptBR = {
  title: 'API',
  navigation: 'Seções da documentação da API',
  short: { address: 'Endereço', caller: 'Quem chama', sdk: 'SDK', examples: 'Exemplos', token: 'Token' },
  description: 'Como o seu app conversa com este projeto.',
  start: 'Conectar meu app',
  openapi: 'Documentação OpenAPI',
  address: 'Endereço do projeto',
  copyAddress: 'Copiar endereço',
  endpoints: {
    rest: 'tabelas, views e funções (rpc) do schema exposto',
    auth: 'cadastro, login, sessão e usuário atual',
    jwks: 'chave pública para validar os JWTs',
  },
  caller: 'Quem faz a chamada',
  callerHint:
    'Não existe chave anon: quem não manda token já é anon. O acesso de cada papel (role) é definido por tabela, nas permissões da tabela (GRANTs, na aba Estrutura) e nas regras de acesso (RLS).',
  roles: {
    anon: {
      title: 'Visitante',
      text: 'Requisição sem o cabeçalho Authorization. Vê o que as permissões da tabela (GRANTs) e as regras de acesso (RLS) liberam para o papel (role) anon.',
    },
    authenticated: {
      title: 'Usuário logado',
      text: 'Authorization: Bearer com o access_token do login. auth.uid() é o id dele nas regras de acesso.',
    },
    service_role: {
      title: 'Seu backend',
      text: 'Bearer com o token service_role. Ignora o RLS (mas precisa de permissão na tabela, o GRANT): só em código que roda no servidor.',
    },
  },
  neverInBrowser: 'Nunca use no navegador.',
  examples: 'Exemplos',
  topic: 'Assunto',
  topics: {
    tables: 'Tabelas',
    auth: 'Autenticação',
  },
  table: 'Tabela',
  language: 'Linguagem',
  noTables: 'Crie uma tabela para ver exemplos com as colunas dela.',
  types: 'Tipos TypeScript das tabelas:',
  downloadTypes: 'Baixar database.ts',
  sdkLabel: 'TypeScript (SDK)',
  sdk: {
    title: 'Conectar com o SDK',
    text: 'O cliente oficial em TypeScript: tipado pelas suas tabelas, renova a sessão sozinho e roda no navegador, Node, Deno e Bun.',
    install: 'Instale',
    client: 'Crie o cliente',
    types: 'Gere os tipos das suas tabelas e salve ao lado do cliente',
    orCli: 'ou pelo terminal:',
    docs: 'Documentação do SDK',
  },
  ai: {
    title: 'Contexto para IA',
    text: 'Um texto no estilo llms.txt para colar no ChatGPT, Claude, Cursor ou outra IA: traz o endereço deste projeto, o schema com os tipos, as regras de acesso (RLS), os buckets e como usar o SDK. Assim a IA escreve código que funciona aqui, sem inventar tabelas.',
    safe: 'Não inclui chaves, senhas nem tokens. Gere de novo depois de mudar o schema.',
    copy: 'Copiar contexto',
    copied: 'Contexto copiado. Cole na conversa com a IA.',
    download: 'Baixar llms.txt',
    building: 'Montando…',
    failed: 'Não foi possível montar o contexto: {message}',
    preview: 'Ver o texto ({size})',
  },
  snippets: {
    list: {
      label: 'Listar linhas',
      description: 'As 20 primeiras (order=coluna.desc ordena). Sem token, vale o que o papel (role) anon pode ver.',
      sdk: 'As 20 primeiras. Sem login, vale o que um visitante pode ver.',
    },
    filter: {
      label: 'Filtrar',
      description: 'Operadores: eq, neq, gt, gte, lt, lte, ilike, in, is (ex.: {column}=ilike.*abc*).',
      sdk: 'Filtros: eq, neq, gt, gte, lt, lte, like, ilike, in, is e or(...). O valor é checado pelo tipo da coluna {column}.',
    },
    insert: {
      label: 'Inserir',
      description: 'Colunas ausentes recebem o DEFAULT. Prefer: return=representation devolve a linha criada.',
      sdk: 'Colunas ausentes recebem o DEFAULT. .select() devolve a linha criada.',
    },
    update: {
      label: 'Atualizar',
      description: 'PATCH exige filtro: sem ele a API recusa, para não alterar a tabela inteira.',
      sdk: 'Exige filtro: sem ele a API recusa, para não alterar a tabela inteira.',
    },
    delete: {
      label: 'Apagar',
      description: 'DELETE também exige filtro.',
      sdk: 'Também exige filtro.',
    },
    signup: {
      label: 'Criar conta',
      description: 'Devolve a sessão (access_token e refresh_token) já logada.',
      sdk: 'session vem null enquanto o e-mail aguarda confirmação.',
    },
    login: {
      label: 'Entrar',
      description: 'O access_token vai no cabeçalho Authorization das chamadas à API (papel authenticated).',
      sdk: 'Depois disso, toda chamada vai com o token do usuário (papel authenticated).',
    },
    refresh: {
      label: 'Renovar a sessão',
      description: 'O access_token expira em minutos; troque o refresh_token por um par novo.',
      sdk: 'O SDK renova a sessão antes de expirar, em todas as abas. onChange avisa quando ela muda.',
    },
  },
  code: {
    label: 'Código',
  },
  token: {
    title: 'Token',
    intro: 'Para o seu backend chamar a API como service_role, sem passar pelas regras de acesso.',
    warningTitle: 'Ignora todo o RLS',
    warning: 'Guarde como uma senha: nunca no frontend, num app mobile ou num repositório.',
    details:
      'O token não fica guardado no servidor: vale até expirar, e gerar outro não invalida os anteriores. Ainda depende de GRANT em cada tabela (as criadas pelo painel já dão acesso total ao service_role).',
    copy: 'Copiar token',
    reveal: 'Mostrar token',
    hidden: 'Token oculto',
    confirmTitle: 'Gerar um token service_role?',
    confirmDescription:
      'Ele vale por {validity}, ignora a proteção de linhas (RLS) de todas as tabelas e não pode ser revogado: só deixa de valer quando expira. Gere apenas para o código do seu servidor.',
    copyNow: 'Copie agora: ele não será mostrado de novo. Vale até {date}.',
    validity: 'Validade',
    days: { one: '{count} dia', other: '{count} dias' },
    oneYear: '1 ano',
    generating: 'Gerando…',
    generateAnother: 'Gerar outro',
    generate: 'Gerar token',
    orOnServer: 'ou no servidor:',
  },
}

export default ptBR
