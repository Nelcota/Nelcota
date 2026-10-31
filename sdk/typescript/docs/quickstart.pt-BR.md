# Começando com o SDK JavaScript do Nelcota

Este guia descreve o SDK **0.2.5**. Ele traz as correções de sessão, refresh,
consultas e transporte do [changelog](../CHANGELOG.md), além das que o 0.2.1 trouxe
sobre o 0.2.0. O cancelamento passa a retirar
logins pendentes da fila, preservando a conclusão de operações já aceitas.
`Bucket.file_size_limit` passa a `number | string | null`: mantenha limites
grandes como strings decimais exatas ao ler e atualizar o bucket. O SDK envia
esses valores como inteiros JSON, e o servidor mantém as validações de faixa.
Converter primeiro para `number` pode perder precisão; use `null` para limpar
o limite. Atualizar o servidor não atualiza o pacote do aplicativo.

O mesmo pacote funciona em JavaScript e TypeScript. Use um servidor Nelcota
com os recursos descritos na [matriz de compatibilidade](../README.md#compatibility).

## 1. Instale

```sh
bun add @nelcota/client@0.2.5   # ou: npm install @nelcota/client@0.2.5
```

A versão 0.2.5 está publicada no npm. Leia as [notas de atualização](contract.md#upgrading-from-020)
e os [comprovantes de publicação](https://github.com/Nelcota/Nelcota/pull/202#issuecomment-6445288705).
Atualizar o servidor não instala os pacotes do cliente. Os comandos a seguir
servem apenas para testar alterações futuras do checkout como arquivo local:

```sh
cd sdk/typescript
bun install --frozen-lockfile
NELCOTA_SDK_TARBALL="$(pwd)/$(npm pack --silent)"
mkdir -p ../../.nelcota/sdk-consumer
cd ../../.nelcota/sdk-consumer
npm init -y
npm install "$NELCOTA_SDK_TARBALL"
```

## Atualizar do 0.2.0

Execute `bun add --exact @nelcota/client@0.2.5` (ou `npm install --save-exact @nelcota/client@0.2.5`),
confira a versão com `bun pm ls` (ou `npm ls @nelcota/client`) e versione o manifesto/lockfile do aplicativo. Rode seus
testes, a checagem de tipos e o build. Preserve `number | string | null` nos
limites de bucket; strings decimais exatas evitam arredondamento de int64.
Os tipos de `single()`/`maybeSingle()` após outro `select()` agora refletem o
resultado correto e podem exigir ajustar código que usava o tipo anterior.

Trate validações de recuperação de senha, link mágico e confirmação com
`await`/`catch` ou `.catch()`: os métodos rejeitam a Promise. Falhas HTTP/rede
continuam no campo `error`. Linhas malformadas, códigos OAuth em branco e uploads
sem corpo são recusados antes do HTTP; representações de storage ausentes geram
`invalid_response`. Campos null válidos, coleções e arquivos vazios continuam
aceitos. Atualize os mocks de HTTP para retornar as representações documentadas.

Recarregue as abas abertas depois da atualização e verifique login, refresh,
logout, leitura/escrita tipada e um upload/download no staging. Cancelar uma
espera na fila não interrompe a publicação de sessão já aceita por outro dono.

## 2. Prepare os dados

Execute [examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql) pelo editor SQL do painel ou copie-o para
`migrations/` e rode `nelcota migrate`. Ele cria `notes` e o bucket privado
`files`, e pode ser executado mais de uma vez. Cada usuário acessa suas
próprias notas e arquivos, conforme as políticas do Postgres.

## 3. Crie o cliente e entre

```js
import { createClient } from '@nelcota/client';

const nelcota = createClient('https://api.exemplo.com');
const { data: session, error } = await nelcota.auth.signInWithPassword({
  email: 'ana@exemplo.com',
  password: 'sua-senha',
});
if (error) throw error;
```

Para criar uma conta, use `auth.signUp({ email, password })`. Se a confirmação
de email estiver ativada, o cadastro retorna `data.session === null`: confirme
o email e depois entre. O cadastro não garante uma sessão imediata.
O SDK guarda um verificador PKCE do cadastro neste navegador; ao abrir o link,
`auth.verifyEmailLink(link)` o envia e a senha escolhida é mantida. Um link
aberto em outro navegador, ou reenviado, confirma o email e entra, mas apaga
essa senha: defina outra com `auth.updateUser({ password })`.

## 4. Grave e consulte

```js
const created = await nelcota.from('notes')
  .insert({ body: 'Minha primeira nota' }).select('id,body').single().execute();
if (created.error) throw created.error;

const { data: notes, error: readError } = await nelcota.from('notes')
  .select('id,body').order('id', { ascending: false }).limit(20).execute();
if (readError) throw readError;
console.log(notes);
```

Para alterar ou excluir, inclua um filtro, por exemplo `.eq('id', id)`.
Uma lista vazia pode significar que a política RLS escondeu as linhas. Consulte
os GRANTs e as políticas no painel para entender uma recusa.

## 5. Envie um arquivo

```js
const path = `${session.user.id}/hello.txt`;
const files = nelcota.storage.from('files');
const upload = await files.upload(path, 'Olá!', { upsert: true });
if (upload.error) throw upload.error;
const downloaded = await files.download(path);
if (downloaded.error) throw downloaded.error;
console.log(await downloaded.data.text());
```

O bucket desse exemplo é privado. Para compartilhar temporariamente, use
`createSignedUrl(path, 60)` e confira seu `error` antes de usar a URL.

## 6. Use TypeScript quando quiser

```sh
nelcota types -o src/database.ts
```

```ts
import { createClient } from '@nelcota/client';
import type { Database } from './database.js';
const nelcota = createClient<Database>('https://api.exemplo.com');
```

Gere os tipos novamente depois de alterar o schema. JavaScript não exige esse
passo; TypeScript usa os tipos para conferir tabelas, colunas e argumentos.

## Exemplos executáveis

- Navegador: no diretório do SDK, rode `bun run build` e
  `bun run example:browser`. Abra `http://127.0.0.1:5178`, informe a URL
  da API e entre. A página permite cadastro, notas e upload.
- Node: configure `NELCOTA_URL`, `NELCOTA_EMAIL`, `NELCOTA_PASSWORD` e rode
  `node examples/node.mjs` no diretório do SDK após instalar o pacote local.
  Use `NELCOTA_SIGN_UP=1` se desejar cadastrar uma conta de teste.
- Servidor: configure `NELCOTA_URL` e rode `node examples/server.mjs`.
  Faça `GET http://127.0.0.1:5179/notes` com o token do usuário no cabeçalho
  `Authorization: Bearer ...`. O exemplo cria um cliente por requisição.

Nos exemplos publicados, os imports usam `@nelcota/client`. Para executá-los
diretamente do checkout, faça o build antes: a resolução do pacote encontra
os exports locais. O servidor do exemplo de navegador fornece um import map.

## Sessões e erros

No navegador, um registro transacional IndexedDB mantém o estado oficial da
sessão e do PKCE; o localStorage é um espelho. Esse comportamento exige
IndexedDB disponível. A renovação é coordenada entre abas com Web Locks.
Em ambientes sem Web Locks, passe
`auth: { storage: sessionStorage }` para manter cada sessão na sua aba.
No servidor, use um cliente por requisição e encaminhe o token do usuário.
Um `service_role` deve permanecer apenas no servidor, pois ignora RLS.

Cada chave de storage mantém um verificador OAuth pendente. Iniciar outro login
substitui a tentativa anterior; a gravação, o redirecionamento e o consumo no
callback usam o mesmo bloqueio. Para fluxos de login independentes, use chaves
de storage diferentes.

HTTP, rede, timeout e cancelamento retornam `{ data, error }`. Configuração
inválida pode lançar uma exceção. Para liberar timers e listeners, use
`nelcota.dispose()`; para encerrar a sessão, use `await nelcota.auth.signOut()`.

Os demais métodos e opções estão no [README](../README.md) e no
[contrato do cliente](contract.md).


## Ciclo de vida e operações longas

A atualização do servidor não atualiza o SDK instalado no aplicativo. Não registre
senhas, tokens, sessões nem URLs assinadas nos logs. Erros do banco também
podem conter dados do aplicativo; remova informações sensíveis da telemetria.

No servidor, crie um cliente por requisição ou forneça o token daquela
requisição. Não compartilhe uma sessão de usuário entre requisições. Desde a
0.2.2, falhas síncronas e assíncronas em `onChange` chegam a
`onBackgroundError`, sem interromper o refresh. O callback pode consultar auth;
o SDK não aguarda sua conclusão dentro da trava da sessão.

Para limitar a espera total, use `.abortSignal(AbortSignal.timeout(15_000))`.
O timeout por tentativa não inclui a espera pelo token nem o intervalo entre
retries. Para arquivos grandes, use `open()`, consuma o stream e cancele o body
em `finally` se parar antes do fim. `download()` armazena o arquivo inteiro em
memória. Corrija um adapter de sessão com falha e persista explicitamente a
sessão retida antes de compartilhá-la novamente.

Desde a 0.2.2, o SDK valida linhas REST como objetos não nulos e exige hints em
relações ambíguas nos dois sentidos. Arrays vazios e campos nulos continuam
válidos. Erros serializados preservam `retryAfter`.

O MIME explícito de upload usa partes de 1 a 127 caracteres ASCII, com letras,
dígitos e `!#$&-^_.+`, como o servidor. Parâmetros após ponto e vírgula continuam
válidos. Valores fora desse conjunto passam a ser recusados antes do upload,
em vez de depender da substituição do tipo declarado no servidor.

### Token fornecido pelo servidor

Com `accessToken`, `getUser()` e `updateUser()` usam a identidade dessa fonte,
sem ler ou alterar a sessão armazenada. Uma fonte nula retorna `session_missing`
sem HTTP; ela não seleciona outra identidade em cache. A renovação automática
fica desativada nos clientes combinados e de auth independentes. Outros métodos
de auth chamados explicitamente ainda podem armazenar sessões; separe clientes
de encaminhamento por requisição dos clientes de login gerenciado.

### Correções de sessão, consultas e transporte

O logout renova apenas uma sessão expirada (com tolerância de cinco segundos para
diferença de relógio) antes de revogá-la, sob o mesmo controle de ciclo de vida;
um token ainda válido é revogado diretamente, mesmo se a renovação falhar. A
renovação serve apenas para a revogação: não é salva nem emite `refreshed`, e o
logout emite um único `signed_out`. Falhas ainda podem impedir a revogação
remota; o estado local é limpo. Uma rotação de resultado incerto não é repetida para tentar encerrá-la.
Toda rejeição 4xx definitiva diferente de `invalid_grant` libera a reserva de
refresh; `invalid_grant` limpa a sessão. Falhas de rede e de gateway mantêm a
proteção contra resultado incerto.

Adaptadores distintos no servidor não compartilham a fila de autenticação.
Clientes com o mesmo adaptador e chave continuam coordenados, e o storage do
chamador em Web e Service Workers mantém Web Locks. Mudanças de conta
e perfil entre abas preservam os eventos corretos; estado inalterado não emite
evento, e sessionStorage explícito permanece isolado por aba.

Filtros em colunas com nomes reservados não são descartados por paginação ou
ordenação. Erros de cardinalidade reportam 406. O timeout de uma resposta bruta
termina nos cabeçalhos; o cancelamento do chamador continua válido para o stream.
O corpo de respostas em buffer continua sob prazo. Valores inválidos de headers
e URLs são erros de uso; falha ao ler um corpo de erro preserva o status HTTP.
