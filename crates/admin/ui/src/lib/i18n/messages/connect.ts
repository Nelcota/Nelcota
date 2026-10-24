// API page: endpoints, roles, service_role token and code examples.
import type { Messages } from '../index.svelte'

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
      sdk: 'session vem null enquanto o email aguarda confirmação.',
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

const en: Messages<typeof ptBR> = {
  title: 'API',
  navigation: 'API documentation sections',
  short: { address: 'Address', caller: 'Who calls', sdk: 'SDK', examples: 'Examples', token: 'Token' },
  description: 'How your app talks to this project.',
  start: 'Connect my app',
  openapi: 'OpenAPI documentation',
  address: 'Project address',
  copyAddress: 'Copy address',
  endpoints: {
    rest: 'tables, views and functions (rpc) of the exposed schema',
    auth: 'sign-up, login, session and current user',
    jwks: 'public key to validate the JWTs',
  },
  caller: 'Who makes the call',
  callerHint:
    'There is no anon key: whoever sends no token is already anon. Each role’s access is defined per table, in the table permissions (GRANTs, on the Structure tab) and in the policies.',
  roles: {
    anon: {
      title: 'Visitor',
      text: 'Request without an Authorization header. Sees what the table permissions (GRANTs) and policies allow for the anon role.',
    },
    authenticated: {
      title: 'Signed-in user',
      text: 'Authorization: Bearer with the access_token from login. auth.uid() is their id in policies.',
    },
    service_role: {
      title: 'Your backend',
      text: 'Bearer with the service_role token. Bypasses RLS (but still needs permission on the table, a GRANT): only in code that runs on the server.',
    },
  },
  neverInBrowser: 'Never use it in the browser.',
  examples: 'Examples',
  topic: 'Topic',
  topics: {
    tables: 'Tables',
    auth: 'Authentication',
  },
  table: 'Table',
  language: 'Language',
  noTables: 'Create a table to see examples with its columns.',
  types: 'TypeScript types for the tables:',
  downloadTypes: 'Download database.ts',
  sdkLabel: 'TypeScript (SDK)',
  sdk: {
    title: 'Connect with the SDK',
    text: 'The official TypeScript client: typed from your tables, refreshes the session by itself and runs in browsers, Node, Deno and Bun.',
    install: 'Install it',
    client: 'Create the client',
    types: 'Generate your tables’ types and save them next to the client',
    orCli: 'or from the terminal:',
    docs: 'SDK documentation',
  },
  snippets: {
    list: {
      label: 'List rows',
      description: 'The first 20 (order=column.desc sorts). Without a token, you get what the anon role can see.',
      sdk: 'The first 20. Without signing in, you get what a visitor can see.',
    },
    filter: {
      label: 'Filter',
      description: 'Operators: eq, neq, gt, gte, lt, lte, ilike, in, is (e.g. {column}=ilike.*abc*).',
      sdk: 'Filters: eq, neq, gt, gte, lt, lte, like, ilike, in, is and or(...). The value is checked against the type of {column}.',
    },
    insert: {
      label: 'Insert',
      description: 'Missing columns get their DEFAULT. Prefer: return=representation returns the created row.',
      sdk: 'Missing columns get their DEFAULT. .select() returns the created row.',
    },
    update: {
      label: 'Update',
      description: 'PATCH requires a filter: without one the API refuses, so the whole table is not changed.',
      sdk: 'Requires a filter: without one the API refuses, so the whole table is not changed.',
    },
    delete: {
      label: 'Delete',
      description: 'DELETE also requires a filter.',
      sdk: 'Also requires a filter.',
    },
    signup: {
      label: 'Sign up',
      description: 'Returns the session (access_token and refresh_token), already signed in.',
      sdk: 'session is null while the email awaits confirmation.',
    },
    login: {
      label: 'Sign in',
      description: 'The access_token goes in the Authorization header of API calls (authenticated role).',
      sdk: 'From then on, every call carries the user’s token (authenticated role).',
    },
    refresh: {
      label: 'Refresh the session',
      description: 'The access_token expires in minutes; trade the refresh_token for a new pair.',
      sdk: 'The SDK refreshes the session before it expires, in every tab. onChange tells you when it changes.',
    },
  },
  code: {
    label: 'Code',
  },
  token: {
    title: 'Token',
    intro: 'For your backend to call the API as service_role, without going through the access rules.',
    warningTitle: 'It bypasses all RLS',
    warning: 'Keep it like a password: never in a frontend, a mobile app or a repository.',
    details:
      'The token is not stored on the server: it lasts until it expires, and generating another does not revoke earlier ones. It still depends on a GRANT on each table (tables created by the panel already give service_role full access).',
    copy: 'Copy token',
    reveal: 'Show token',
    hidden: 'Token hidden',
    confirmTitle: 'Generate a service_role token?',
    confirmDescription:
      'It lasts {validity}, bypasses row protection (RLS) on every table and cannot be revoked: it only stops working when it expires. Generate it only for your server code.',
    copyNow: 'Copy it now: it will not be shown again. Valid until {date}.',
    validity: 'Validity',
    days: { one: '{count} day', other: '{count} days' },
    oneYear: '1 year',
    generating: 'Generating…',
    generateAnother: 'Generate another',
    generate: 'Generate token',
    orOnServer: 'or on the server:',
  },
}

export default { 'pt-BR': ptBR, en }
