# Começando com o SDK JavaScript do Nelcota

Este guia descreve o SDK **0.2.1**, com correções posteriores ao 0.2.0 publicado. O cancelamento passa a retirar
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
npm install @nelcota/client@0.2.1
```

A instalação pelo registro exige a publicação bem-sucedida do 0.2.1. Consulte
as [notas de atualização](contract.md#upgrading-from-020); atualizar o servidor não atualiza seu SDK.
Antes de a versão estar disponível, use um arquivo local validado a partir da
raiz do repositório:

```sh
cd sdk/typescript
npm ci
NELCOTA_SDK_TARBALL="$(pwd)/$(npm pack --silent)"
mkdir -p ../../.nelcota/sdk-consumer
cd ../../.nelcota/sdk-consumer
npm init -y
npm install "$NELCOTA_SDK_TARBALL"
```

## Atualizar do 0.2.0

Execute `npm install --save-exact @nelcota/client@0.2.1`, confira a versão com
`npm ls @nelcota/client` e versione o manifesto/lockfile do aplicativo. Rode seus
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

## 4. Grave e consulte

```js
const created = await nelcota.from('notes')
  .insert({ body: 'Minha primeira nota' }).select('id,body').single();
if (created.error) throw created.error;

const { data: notes, error: readError } = await nelcota.from('notes')
  .select('id,body').order('id', { ascending: false }).limit(20);
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

- Navegador: no diretório do SDK, rode `npm run build` e
  `npm run example:browser`. Abra `http://127.0.0.1:5178`, informe a URL
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

No pacote publicado 0.1.2, a sessão do navegador usa localStorage. Na fonte
atual, um registro transacional IndexedDB mantém o estado oficial da sessão e
do PKCE; localStorage é um espelho. Esse comportamento exige um novo build/pacote
e IndexedDB disponível. A renovação é coordenada entre abas com Web Locks.
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
