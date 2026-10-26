# Começando com Rust

Este guia descreve o SDK **0.1.7**, com as correções publicadas desde a 0.1.3.
Elas recusam `single`/`maybe_single` em HEAD ou escritas sem representação
antes de enviar HTTP: use `.select(...)` para receber a linha de uma escrita.
O cancelamento também retira requisições de auth da fila de ciclo de vida;
uma rotação aceita continua responsável por persistir sua sessão.
Essas correções exigem atualizar o pacote do cliente.

O SDK publicado exige Rust 1.88+ e Tokio nativo. Adicione
`nelcota-client = "0.1.7"` ao Cargo.toml junto com serde, serde_json e Tokio,
como mostra o [README](../README.md). A 0.1.7 está publicada no crates.io; veja os
[comprovantes de publicação](https://github.com/Nelcota/Nelcota/pull/181#issuecomment-6423930169). Veja as [notas de atualização](contract.md#upgrading-from-016).
O checkout do servidor usa Rust 1.99; a versão dele é independente da do SDK.

## Atualizar do 0.1.3

Altere a dependência para `nelcota-client = "0.1.7"` e rode
`cargo update -p nelcota-client --precise 0.1.7`. Confira a versão com
`cargo tree -p nelcota-client`, versione Cargo.toml/Cargo.lock e execute o build
e os testes do aplicativo. Rust 1.88+, Tokio, servidor 0.3.0+ e imports públicos
permanecem compatíveis.

Use `.select(...)` antes de `single`/`maybe_single` nas escritas: HEAD e escritas
sem representação passam a falhar antes de enviar HTTP. Trate `Error::Usage`
para código OAuth em branco e componentes MIME inválidos. Parâmetros válidos,
espaço/tab antes do delimitador e uploads de zero bytes continuam aceitos.
Cancelamentos retiram esperas da fila sem interromper a rotação/persistência já
aceita. Verifique login/refresh/logout, cardinalidade e transferência de arquivos
no staging antes de atualizar os aplicativos de produção.

## Usar o SDK

1. Inicie o Nelcota com `cargo run -- dev` ou use um projeto implantado.
2. Aplique [examples/notes.sql](https://github.com/Nelcota/Nelcota/blob/main/examples/notes.sql) (o mesmo do SDK JavaScript) pelo
   editor SQL do painel ou como migração (`nelcota migrate`).
3. Defina `NELCOTA_URL`, `NELCOTA_EMAIL` e `NELCOTA_PASSWORD` para um usuário
   existente. Como alternativa, passe `NELCOTA_ACCESS_TOKEN`.
4. Execute `cargo run -p nelcota-client --example rest` na raiz do repositório.
   O exemplo cria uma nota, lê, atualiza e remove a nota que acabou de criar.

Para obter modelos do banco:

```sh
nelcota types --lang rust -o src/database.rs
```

Inclua com `mod database;`. Use `database::public::notes::Row` ao selecionar
todas as colunas, ou uma struct própria para projeções. Insert e Update usam
`Field::Omit` para não enviar campos e `Field::Value(None)` para escrever null
em campos anuláveis. Campos calculados não aparecem nas escritas.

Cada cliente mantém sua sessão em memória; clones compartilham a coordenação
de refresh. Em um backend que atende vários usuários, use
`client.with_access_token(token_do_usuario)` por requisição. Isso mantém o
transporte compartilhado e cada chamada com a identidade correta.

Os exemplos `storage` e `oauth` mostram arquivos com streaming e PKCE. Defina
`NELCOTA_ACCESS_TOKEN` e `NELCOTA_UPLOAD_PATH` no primeiro (ele não usa
email/senha); no segundo, configure
`NELCOTA_OAUTH_REDIRECT_URL` também na lista permitida do servidor, abra a URL
impressa e cole a URL de retorno quando solicitado. Eles não imprimem os tokens
da sessão. As políticas do banco continuam decidindo quem pode acessar os dados.


## Ciclo de vida e operações longas

A atualização do servidor não atualiza o SDK instalado no aplicativo. Não registre
senhas, tokens, sessões nem URLs assinadas nos logs. Erros do banco também
podem conter dados do aplicativo; remova informações sensíveis da telemetria.

Clones de `Client` compartilham o mesmo ciclo de login. Para identidades por
requisição, use `with_access_token` ou `anonymous`. Clientes e processos
independentes que compartilham FileStorage precisam coordenar o refresh
externamente. Mantenha o diretório da sessão privado.

Use `tokio::time::timeout` ao redor da operação completa para limitar a espera
total. Desde a 0.1.5, o timeout explícito da query prevalece sobre
`RequestOptions.timeout`; zero desativa esse prazo. Transferências continuam
sem prazo por padrão. Use `open()` e leia os chunks com controle de fluxo para
arquivos grandes; descartar a resposta interrompe a leitura. `download()`
armazena o arquivo inteiro em memória.

Cancelar uma gravação pendente remove apenas seu temporário e preserva a sessão
anterior até o rename. Após o rename, cancelar não desfaz a publicação. No Unix,
o diretório também é sincronizado após gravação ou remoção; no Windows, a
substituição é atômica, sem a mesma promessa de sincronização do diretório.
Falhas do filesystem ainda podem impedir a limpeza e devem ser tratadas.

O MIME explícito de upload usa partes de 1 a 127 caracteres ASCII, com letras,
dígitos e `!#$&-^_.+`, como o servidor. Parâmetros após ponto e vírgula continuam
válidos. Valores fora desse conjunto passam a ser recusados antes do upload,
em vez de depender da substituição do tipo declarado no servidor.

### Encerramento de sessões e filtros reservados

O logout renova apenas uma sessão expirada (com tolerância de cinco segundos para
diferença de relógio) antes de tentar revogá-la, sob o controle existente de
ciclo de vida; um token ainda válido é revogado diretamente. A renovação serve
apenas para a revogação: não é salva nem emitida como `Refreshed`. O estado local é limpo mesmo se a revogação falhar;
essa falha não representa confirmação de encerramento remoto. Filtros em
colunas com nomes reservados usam grupos lógicos para que paginação e ordenação
não descartem a condição, inclusive em caminhos de tabelas relacionadas.
