# Next.js — candidato do G11

**Protótipo não publicado e ainda não aprovado para produção.** Consulte a
[execução do G11](../../../docs/goals/nextjs-sdk-execution.md). O adaptador exige
a correção local do SDK TypeScript para #132; a versão publicada 0.2.1 ainda não
é uma dependência suficiente. A publicação está bloqueada pelos critérios do goal.

Escopo inicial: App Router no runtime Node.js, Next 16.4.3, React 19.3.1 e Node 24.
Não há certificação de Node 22, Next anterior, Pages Router ou Edge.

## Organização e configuração

Compartilhe somente configuração, chaves e pool. Crie clientes/identidades por
requisição com `createNelcotaNext` de `@nelcota/nextjs/server`. Nunca compartilhe
um cliente autenticado global nem use uma credencial de operador/service role
para representar visitantes. REST/RPC/storage reutilizam `@nelcota/client`; as
permissões e RLS do backend continuam sendo a autorização.

Em produção use HTTPS, `appOrigin` explícita e `PostgresSessionStore` de
`@nelcota/nextjs/postgres`. Execute `sql/session-store.sql` com o proprietário de
um banco privado de sessões. A role da aplicação precisa somente de CONNECT,
USAGE no schema e SELECT/INSERT/UPDATE/DELETE na tabela; não conceda acesso às
roles públicas da API. Configure TLS com verificação de certificado, limite o
pool e trate seu evento `error` sem registrar URLs/senhas. Feche o pool ao parar
a aplicação. Consulte o exemplo de configuração no README em inglês.

Use conexão direta ou pool de sessão; pool por transação é incompatível com
advisory locks de sessão. Cada gravação é confirmada antes de resolver a Promise.
Requisições da mesma sessão aguardam numa fila do processo antes de usar uma
conexão do pool, e o lock é tentado com `pg_try_advisory_lock` dentro do
`timeout` do store (5 s por padrão). Se não for obtido, a operação falha com
`SessionError` `session_store` sem deixar um backend esperando no PostgreSQL.
`new PostgresSessionStore(pool, timeout, leaseTimeout)` usa 5 s / 60 s por padrão
e exige `leaseTimeout >= 2 * timeout`. Cada chamada de auth dentro do lease recebe
no máximo o tempo restante do lease menos um `timeout` do store, reservado para
gravar o resultado. Se não couber, retorna o erro de auth `lease_exhausted` antes
de ser enviada.
Uma transação SQL não torna atômicas uma rotação no servidor de auth e sua
persistência local; perder a resposta pode exigir novo login.

Gere uma chave com `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`.
Guarde no ambiente secreto do servidor, sem prefixo `NEXT_PUBLIC_`. Durante a
rotação informe a chave atual e até duas anteriores, mantendo-as durante a
validade máxima das sessões. Perder todas as chaves antigas encerra essas sessões:
uma linha ilegível ou com expiração divergente é lida como sem sessão
(`staleCookie` verdadeiro), a próxima gravação a remove e segue sem sessão, e o
proxy limpa o cookie ao redirecionar para o login. Não coloque chaves, tokens ou cookies em logs,
props, URLs de redirecionamento ou bundles públicos.

O cookie contém somente um ID aleatório opaco; é HttpOnly, SameSite=Lax,
host-only, Secure e `__Host-` em produção. Estado no banco usa AES-256-GCM,
expiração e vínculo com a aplicação/API. O cookie recebido nunca é encaminhado
à API. Uma gravação nunca adota um ID sem linha armazenada; login, cadastro,
troca OAuth, verificação por link e redefinição de senha movem o estado para um
ID novo e removem a linha antiga (leases de `SessionStore` próprios implementam
`rotate(key)`). Agende a remoção limitada de linhas expiradas conforme o SQL do README;
registre apenas contagens. `DevelopmentSessionStore` é explícito, volátil e
restrito a desenvolvimento loopback; não atende múltiplos processos.

## Componentes, rotas e ações

- `(await nelcota).server(async ({ getUser, client }) => ...)`: consulta usuário
  no serviço de auth, sem confiar apenas no JWT decodificado. Não renova sessão,
  não grava cookie nem permite mutações. Renderize páginas de usuário de forma
  dinâmica; não use cache compartilhado/ISR para resultados autenticados.
- `.route(request, async ({ auth, client }) => Response)`: contexto de escrita
  para Route Handler. Métodos inseguros exigem Origin exata configurada. Origin
  ausente/estrangeira é recusada antes de mudar estado ou chamar a API. Leia o
  corpo da requisição **antes** de `route()`: o callback mantém o lease da
  sessão (e, com PostgreSQL, uma conexão do pool) até terminar. Não faça nele
  I/O lento alheio à autenticação, como corpos, uploads ou chamadas externas.
- `.action(async ({ auth }) => ...)`: Server Action. Valide campos/tamanhos e
  confira o resultado antes de `redirect('/profile')`. O redirecionamento do
  Next lança uma exceção; não a transforme em erro de autenticação.
- `.callback(request, ...)`: somente GET em `/auth/callback`, com cookie,
  estado e PKCE de uso único. Com `basePath` do Next, informe a opção `basePath`
  (ex.: `'/app'` resulta em `/app/auth/callback`; os redirecionamentos do proxy
  também a incluem). A callback é reconhecida só pelo caminho, e `redirectTo` usa
  a `appOrigin` configurada. Host e cabeçalhos encaminhados não são confiáveis. Somente `auth.exchangeCode()` é permitido;
  mutações comuns e gravações de dados são recusadas nesse contexto GET.

Os métodos de auth cobrem login, cadastro, logout, renovação, usuário, atualização,
recuperação, links de email e OAuth. Eles retornam dados de usuário, sem expor os
tokens ao navegador. Aguarde todas as operações e não reutilize o contexto após
seu encerramento. Falhas de persistência/cookie não são sucesso silencioso.
Mapeie `SessionError.code === 'csrf'` para 403 genérico e falhas de persistência
para 503 genérico. Não publique causas internas, corpos ou credenciais.
Cada contexto de escrita tenta antes renovar uma sessão prestes a expirar. Se
essa renovação falhar com 429/5xx ou erro de rede, o callback roda mesmo assim
com a sessão armazenada. O logout ainda limpa o estado local, e o resultado de
auth traz o erro do backend.

Inicie OAuth por POST/Action com `auth.startOAuth({ provider, returnTo })`.
Na callback, troque o código com `auth.exchangeCode()` e redirecione apenas ao
`returnTo` local validado. Não reflita o parâmetro `next` nem credenciais da URL.
Uma tentativa com estado incorreto não consome o verificador válido.

No navegador importe somente `refreshSession` de `@nelcota/nextjs/browser`.
Crie o POST `/auth/session/refresh` chamando `auth.refresh()`. A página
`/auth/refresh` pode apresentar um botão Continuar para fazer esse POST. O proxy
opcional cuida de navegação, não renova sessão nem substitui RLS. Evite loops
excluindo login, callback e as páginas/rotas de renovação. Codificações ambíguas
recebem 400 só em caminhos que, decodificados, possam atingir um prefixo
protegido. Caminhos públicos como `/blog/50%25-off` passam normalmente.

Para remover explicitamente uma sessão local ilegível, use uma rota POST de
mesma origem chamando `.forgetLocalSession(request)`. Isso não promete revogar
no backend um token que já não pode ser recuperado.

## Limites atuais e testes

Os testes com PostgreSQL cobrem dois proprietários independentes, persistência,
perda de conexão e recuperação do lock. **Logins iniciais simultâneos, antes de
existir cookie, ainda têm um critério aberto:** respostas com IDs diferentes
podem disputar a identidade final do navegador. Não há promessa de segurança
completa entre abas/processos até resolver e testar esse caso.

Também faltam matriz completa de fluxos, pacote instalado por consumidor externo,
versões adicionais, recursos e backend compilado do código final. O teste de RLS
atual é de compatibilidade com um binário identificado, não aprovação final.

Use o PostgreSQL descartável do repositório e rode Rust, Vitest e auditorias em
sequência, conforme AGENTS.md. `npm --prefix sdk/nextjs run check`, `npm --prefix
sdk/nextjs test` e `npm --prefix sdk/nextjs run build` verificam o candidato. O teste
PostgreSQL exige `NELCOTA_NEXT_TEST_DATABASE_URL` e cria/remove um banco próprio.
Não use dados nem credenciais de produção. O exemplo App Router é loopback de
desenvolvimento; não deve ser publicado como configuração de produção.

O download S3 por redirecionamento pré-assinado também está pendente: o adaptador
atual recusa redirecionamentos da API. É necessária uma política explícita de
destinos, remoção de credenciais e testes com o provedor. Não libere todos os
redirecionamentos para contornar essa limitação.
