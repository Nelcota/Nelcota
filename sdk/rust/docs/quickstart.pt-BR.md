# Começando com Rust

O SDK usa Tokio e requer Rust 1.88+. Este checkout prepara 0.1.3; adicione
`nelcota-client = "0.1.3"` ao Cargo.toml somente após a publicação, junto de
serde, serde_json e tokio (veja o README). Antes disso, use uma dependência
local `path` para `sdk/rust` ou o arquivo validado. O pacote publicado 0.1.2
tem comportamento anterior. O servidor compilado do repositório exige Rust
1.99.0; ele e o SDK têm versões independentes.

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
`NELCOTA_UPLOAD_PATH` para o arquivo no primeiro; no segundo, configure
`NELCOTA_OAUTH_REDIRECT_URL` também na lista permitida do servidor, abra a URL
impressa e cole a URL de retorno quando solicitado. Eles não imprimem os tokens
da sessão. As políticas do banco continuam decidindo quem pode acessar os dados.
