# Next.js 0.1.1

This integration requires the published `@nelcota/client` 0.2.2 or later.
Confirm `@nelcota/nextjs@0.1.1` registry availability before installation;
source verification does not publish a package. See the
[release instructions](releasing.md) and [G11 execution record](../../../docs/goals/nextjs-sdk-execution.md).

The verification matrix covers App Router, Next 16.4.3 / React 19.3.1,
Node 22/24/26 with Chromium, and Node 24 with Firefox/WebKit. Previous Next
majors, Pages Router and Edge are outside the supported scope.

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
proxy limpa o cookie ao redirecionar para o login (exceto um cookie substituído,
veja abaixo). Não coloque chaves, tokens ou cookies em logs,
props, URLs de redirecionamento ou bundles públicos.

O cookie contém somente um ID aleatório opaco; é HttpOnly, SameSite=Lax,
host-only, Secure e `__Host-` em produção. Estado no banco usa AES-256-GCM,
expiração e vínculo com a aplicação/API. Cada gravação deriva sua própria chave
AES com HKDF-SHA-256 a partir da chave primária e de um salt aleatório (formato
`v2`); linhas no formato anterior `v1` continuam legíveis. O cookie recebido nunca é encaminhado
à API. Uma gravação nunca adota um ID sem linha armazenada; login, cadastro,
troca OAuth, verificação por link e redefinição de senha movem o estado para um
ID novo e trocam a linha antiga por uma lápide sem credenciais (leases de
`SessionStore` próprios implementam `rotate(key, retain?)`: substituem a linha
atual por `retain` quando informado ou a removem). Agende a remoção limitada de linhas expiradas conforme o SQL do README;
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
- `.action(async ({ auth }) => ...)`: Server Action. O Next só as chama via
  POST; a proteção CSRF vem da verificação exata de `Origin` e da checagem de
  origem do próprio Next. Não amplie `serverActions.allowedOrigins`. Valide campos/tamanhos e
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
perda de conexão e recuperação do lock.

**Logins simultâneos e ordem das respostas.** O navegador fica com o último
`Set-Cookie` que processa. Todos os IDs que descendem de um mesmo cookie
formam uma **linhagem**. Um registro selado de cabeça (mesma tabela) indica a
única chave viva e uma geração monotônica. Login, cadastro, troca OAuth,
verificação por link, redefinição de senha e logout tornam sua chave a nova
cabeça sob o lock da linhagem. Uma linha de sessão só vale enquanto a cabeça
indica sua chave e geração. Um cookie substituído é lido como sem sessão
(`staleCookie` e `superseded` verdadeiros), nunca como o usuário antigo. Antes
de gravar ou limpar o cookie, a escrita confere a cabeça de novo. Se uma
identidade posterior venceu nesse meio-tempo, ela não grava nem limpa o cookie
e troca a própria linha por uma lápide. O resultado de auth já devolvido
descreve essa tentativa perdedora. Linhas substituídas viram lápides depois que
a requisição vencedora libera o lock, ou quando o ID é apresentado. Escritas
que não publicam nada não limpam cookies substituídos ou sem linha. O proxy
opcional entrega a um navegador sem cookie um ID de bootstrap aleatório e sem
credenciais em `bootstrapPaths` (padrão `[loginPath]`), para que abas que
carregaram o login compartilhem a linhagem. Custo: uma leitura extra do store
por requisição com sessão e duas linhas por linhagem.

**Limite residual (semântica de cookies HTTP).** Requisições *sem* cookie de
sessão não têm nada que o servidor possa ligar. Sem ID de bootstrap (sem proxy,
caminho fora de `bootstrapPaths`, ou respostas de bootstrap ainda em trânsito),
dois logins iniciais simultâneos continuam sessões independentes. O navegador
fica com a última, e a outra linha fica inalcançável, com credenciais
cifradas, até expirar e ser removida pela limpeza. O mesmo vale quando se perde
a resposta da cabeça vencedora: ela dura até o próximo login/logout da
linhagem ou até expirar. A lápide só apaga estado local; não revoga o refresh
token substituído no servidor de auth. Os testes cobrem store em memória,
PostgreSQL com pool simulado e duas instâncias, e PostgreSQL real com dois
pools, além do residual sem cookie. Em 2026-10-24, um navegador real (build de
produção do Next e Chromium) fez login ao mesmo tempo em duas abas que
compartilham o mesmo conjunto de cookies e carregaram a página de login. Com as
respostas entregues em ordem inversa, ou com a resposta vencedora perdida, o
navegador ficou sem sessão, nunca com a identidade mais antiga. Na ordem
natural, ficou com a mais nova. A linha da vencedora perdida deixou de valer
no login seguinte desse navegador. Abas que não passaram pelo caminho de
bootstrap ficaram com a identidade mais antiga, que é o limite residual acima.

Na mesma data passaram o pacote empacotado num consumidor externo, o build
negativo de fronteira e os testes de backend/RLS e de storage S3 com um binário
compilado do código atual. Ainda faltam a matriz completa de fluxos de auth,
versões adicionais de Node/Next/navegador, medições de recursos e uma versão
publicada do SDK base com as correções exigidas.

Use o PostgreSQL descartável do repositório e rode Rust, Vitest e auditorias em
sequência, conforme AGENTS.md. `npm --prefix sdk/nextjs run check`, `npm --prefix
sdk/nextjs test` e `npm --prefix sdk/nextjs run build` verificam o candidato. O teste
PostgreSQL exige `NELCOTA_NEXT_TEST_DATABASE_URL` e cria/remove um banco próprio.
Não use dados nem credenciais de produção. O exemplo App Router é loopback de
desenvolvimento; não deve ser publicado como configuração de produção.

Os scripts `package-smoke`, `boundary-smoke`, `framework-smoke` (com
`CHROMIUM_PATH`), `backend-smoke` e `storage-smoke` ficam em `sdk/nextjs/scripts`.
Rode um de cada vez, depois de `run build`. Os dois últimos usam `node
--conditions=react-server` e exigem `NELCOTA_NEXT_TEST_BINARY` e
`NELCOTA_NEXT_TEST_DATABASE_URL`. O de storage também exige
`NELCOTA_NEXT_TEST_S3_ENDPOINT`, `NELCOTA_NEXT_TEST_S3_ACCESS_KEY_ID` e
`NELCOTA_NEXT_TEST_S3_SECRET_ACCESS_KEY` de um provedor S3 descartável em
loopback. Veja os comandos completos no README.

## Downloads do storage e redirecionamentos S3

Requisições de API, auth e REST/RPC nunca seguem redirecionamentos. Com S3, um
download pode ser redirecionado para uma URL pré-assinada. Permita isso de forma
explícita com `storageRedirectOrigins: ['https://meu-bucket.s3.sa-east-1.amazonaws.com']`.

- Só requisições `GET`/`HEAD` de objetos em `/storage/v1/object/` seguem
  redirecionamentos, com `redirect: 'manual'` e no máximo três saltos. O
  `Location` de cada salto precisa resolver para uma origem da lista.
- As origens são HTTPS absolutas, sem caminho, query ou credenciais, no máximo
  dezesseis. HTTP só é aceito para loopback com `allowInsecureDevelopment`.
- No primeiro salto para fora da origem da API, a requisição mantém só `accept`,
  `range` e os cabeçalhos condicionais. `Authorization`, cookies, `apikey` e
  todo o resto são removidos e não voltam nos saltos seguintes.
- Sem a opção, ou para um destino fora da lista, o erro é
  `storage_redirect_refused`, e o destino nunca é contatado. Saltos demais
  resultam em `storage_redirect_limit`.

Testes unitários e um redirecionamento HTTP real em loopback cobrem isso. Em
2026-10-24, `scripts/storage-smoke.mjs` rodou um servidor Nelcota do código
atual com backend S3 e um provedor RustFS 1.0.1 em loopback, o mesmo serviço
compatível com S3 usado na CI. Os binários comunitários do MinIO não são mais
distribuídos. A API respondeu 302 para uma URL pré-assinada do provedor. Com a
origem do provedor na lista, o download devolveu os bytes enviados e um pedido
com `range` recebeu 206. Só cabeçalhos permitidos chegaram ao provedor, sem
`Authorization`, cookie ou `apikey`. Sem a opção, ou com outra origem na lista,
o erro foi `storage_redirect_refused` e o provedor não foi contatado. AWS S3,
R2, outros provedores e endpoints HTTPS não foram testados.
