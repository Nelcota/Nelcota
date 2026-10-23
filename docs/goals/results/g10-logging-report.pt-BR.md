# G10 — Relatório técnico de logs operacionais

Passada delimitada com quatro correções comprovadas e verificações locais. Não significa que todos os logs do sistema, do PostgreSQL, do proxy ou de provedores foram certificados como seguros.

## O que mudou

- O log HTTP usa a rota reconhecida pelo roteador, como `/rest/v1/{table}`, em vez do nome real da tabela/arquivo. Métodos não padronizados viram `OTHER`. IDs de correlação registrados ficam limitados a128 caracteres seguros; os demais aparecem como `[redacted]`. O cabeçalho devolvido e os IDs comuns do proxy permanecem iguais.
- Eventos do banco preservam SQLSTATE e categorias estáveis, sem renderizar mensagens opacas. O pool diferencia pressão de espera, criação/reciclagem, backend e encerramento. Respostas HTTP, campos de erro e políticas de retry não foram alterados.
- Falhas do mailer deixam de copiar o texto externo; mantêm evento, tipo estático e categoria da mensagem. Timeout, admissão e resposta pública permanecem iguais.
- Falhas de storage e cleanup deixam de copiar textos opacos, buckets, chaves e caminhos. Mantêm eventos e causas IO tipadas quando disponíveis; o evento de bytes ausentes mantém UUID de versão. A remoção da chave privada usada só para logging não muda a posse do permit nem o abort multipart.
- O guia do painel, em inglês e português, explica correlação, acesso restrito, retenção, revisão antes de compartilhar e os limites dos logs como evidência. Assets recompilados em commit separado. Nenhum destino externo ou leitor privilegiado de logs foi criado.

## Evidência

Na base, um teste de correlação passou e seis regressões falharam. No candidato, os sete passaram em texto e JSON. Uma regressão adicional de provedores falhou antes, em texto e JSON, por cinco observações: texto de e-mail, linha grande, bucket, caminho de disco e chave/caminho no delete diferido. Passou depois nos dois formatos, preservando signup201/recover200/upload201/ausência404/falha500. Duas tentativas iniciais tinham fixture de auth inválida e não foram usadas como prova; outra tentativa não compilou após remover um campo privado do Guard e foi corrigida no construtor do teste, sem alterar suas asserções. Foram repetidos16 testes unitários de storage,53 de auth,3 de API storage e as regressões de logging/hardening, todos passando.

Mais4 testes de erros,7 de hardening,1 do contrato de request-ID e1 de memória/cancelamento passaram;37 testes de guias também passaram. Fmt, Clippy com warnings como erro, limites de módulos, catálogos, build do painel e build release passaram. Tentativas iniciais que não compilaram ficaram registradas; a correção foi habilitar um recurso vazio já existente do Axum, sem adicionar dependências ou mudar lockfiles.

O teste do ELF real preservou201/404 e confirmou ausência do canário de caminho no candidato. A hipótese de mensagens DEBUG do driver SQL foi descartada neste artefato; nenhum filtro foi adicionado sem necessidade. Capturas brutas não foram guardadas: só contagens, flags e hashes de canários sintéticos.

Comparação WARN em carga fixa: campanha funcional passou, mas o gate de desempenho FALHOU em RLS, storage e login. Causa inconclusiva; nenhuma aprovação de desempenho. Não mede overhead de logging INFO/JSON.

## O que continua aberto

L01/L02 foram corrigidos e validados no limite da aplicação. L03 e L04 tiveram correções delimitadas em mail/storage; OAuth, IDs de conta/sessão e política de auditoria precisam de investigação própria. L05–L07 tiveram inventário de código, preservando o comportamento existente; não receberam certificação geral de falhas/cleanup/telemetria. L08 teve guia validado, mas rotação/journald/PostgreSQL/proxy da VPS não foram alterados nem certificados. L09 cobre entradas grandes e o perfil medido, sem promessa de custo zero. L10 comprova correlação e categorias em cenários sintéticos; não comprova conclusão de uma operação durável.

Não envie `.env`, cookies, JWTs, URLs assinadas, dumps ou armazenamento completo do navegador ao pedir suporte. JSON estruturado não anonimiza automaticamente mensagens externas. Logs ajudam o diagnóstico; não autorizam repetir uma mutação nem remover uma trava de restore.

## Procedência e tempo

Base4d403483; branch local `local/g10-operational-logging`. ELF final de bd805a24, SHA-256 `ec72a81da28046b3062a71093f27a61e1bbe609ba90788b9f891cb7660718127`. O primeiro ELF a2e28419 permanece preservado, sem campanha de carga; não foi substituído nem relabelado. Commits de código36408d25/b1eb7282; guia27b2f9af; assets55a91880. Fix provider ab587ca5, guia3447cc0c e assetsbd805a24. G09 é independente e não certifica o artefato combinado.

A primeira etapa começou02:08:47 UTC e ficou incompleta; o prazo original08:08:47 venceu no intervalo sem execução. A continuação pedida pelo usuário foi registrada separadamente às11:07:20, limitada a15:07:20 UTC. O intervalo não conta como teste. O PostgreSQL de testes ficou ocioso durante a pausa e foi removido antes das medições finais. O relatório preserva essa limitação e os resultados que falharam.

Evidências privadas em `target/g10/20261023T020847Z` e `target/g10/20261023T110720Z`. Sem push, PR, merge, release, deploy ou acesso à VPS. CI público não executado; resultados locais não o substituem.

## Exemplo seguro de diagnóstico

Um evento JSON sintético tem apenas campos controlados, por exemplo `{"event":"auth.mail_delivery_failed","error_type":"nelcota_auth::mail::MailError","kind":"recovery"}`. O nome concreto do tipo é contexto de implementação e não contrato de API. Para banco, use o SQLSTATE e o request-ID limitado para correlacionar; não anexe SQL, valores, `.env` ou logs completos ao chamado. Proxy/PostgreSQL podem ter sinks próprios e exigem revisão separada.

A matriz L01–L10 e os comandos estão no [registro em inglês](../operational-logging-execution.md). Retenção/rotação real, acesso a journald/Docker e diagnóstico da VPS ficaram bloqueados; nenhum destino de e-mail/webhook real foi acionado.

## Comparação completa de disco

| Cenário | Controle p95 ms | Logs v2 p95 ms | Variação | Gate |
| --- | ---: | ---: | ---: | --- |
| read | 4.055834 | 3.169016 | -21.87% | passou |
| rls | 3.399168 | 4.070303 | +19.74% | FALHOU |
| panel | 4.628328 | 4.930588 | +6.53% | passou |
| storage | 8.124890 | 9.083252 | +11.80% | FALHOU |
| login | 28.980586 | 33.113196 | +14.26% | FALHOU |
| refresh | 9.170996 | 8.573691 | -6.51% | passou |
| mixed | 22.742986 | 22.898167 | +0.68% | passou |

Três amostras válidas por lado, perfil e tetos originais. Fila final zero, nenhuma transação ociosa ou lock após carga,17 objetos conferidos e nenhuma assinatura inválida. A comparação falha não foi apagada. Correções confirmadas de diagnóstico permanecem locais, com a regressão de desempenho aberta para investigação antes de aprovação/publicação. Não há nova rodada para selecionar amostras verdes.

S3 local: três amostras válidas por lado; p95 mediano 17.715696ms → 16.414860ms (-7.34%), gate aprovado. Este resultado não apaga as falhas de disco nem mede S3 remoto/TLS ou custo INFO/JSON.

## Encerramento

Tráfego comparável G10: 27.84min estimados pelos resumos k6 concluídos, preparação excluída. Disco: verificações funcionais/recursos passaram, gate de latência falhou em três cenários. S3: verificações e gate passaram. Custo INFO/JSON não medido; aprovação de desempenho continua bloqueada. A rodada contínua G09 usa outro ELF e não conta como endurance G10.

Nenhum recurso nomeado da campanha ficou ativo. Objetos Docker antigos foram preservados. Como próximos limites de investigação: OAuth, IDs de conta/sessão, retenção das observações do painel e propagação de contexto async. A redação de tracing não certifica esses registros separados, PostgreSQL/proxy ou todo sink. Não houve push/PR/merge nem alteração na VPS.

## Complemento da revisão: p50 e p99

Medianas dos três quantis por amostra, em ms; não são quantis de uma distribuição combinada. Perfil completo de disco já registrado acima.

| Cenário | Controle p50 | Candidato p50 | Controle p99 | Candidato p99 |
| --- | ---: | ---: | ---: | ---: |
| read | 2.230 | 2.070 | 6.401 | 5.273 |
| rls | 2.271 | 2.359 | 5.529 | 6.116 |
| panel | 3.138 | 3.269 | 7.200 | 7.548 |
| storage | 3.126 | 3.548 | 14.727 | 14.162 |
| login | 22.314 | 24.108 | 38.685 | 48.576 |
| refresh | 4.527 | 4.341 | 26.397 | 26.091 |
| mixed | 2.523 | 2.470 | 28.865 | 28.722 |

## Revisão posterior

Revisão completa dos diffs de produção/testes, alteração mínima do sampler, retirada da otimização, relatórios e integridade do pacote anterior. Nenhum novo defeito de produção confirmado nesta revisão. A aprovação de desempenho continua bloqueada; os resultados anteriores não foram repetidos nem reescritos.

Lacuna corrigida: o teste de provedor usava uma variável para alternar JSON, então o cargo test comum cobria só texto. Agora dois executáveis de integração executam texto/JSON automaticamente, com casos compartilhados. A asserção de e-mail espera especificamente kind=recovery; signup nesta fixture não enviava confirmação, portanto não foi demonstrada uma race no teste anterior. O caso JSON valida as linhas e o caso de delete diferido também exige a presença do diagnóstico. Commit de testes2c6017f8; sem dependências/workflows novos.

Verificação posterior:9 testes Rust (7 HTTP/banco +1 provedor texto +1 provedor JSON),2 testes Chromium retidos após o revert, fmt, Clippy server/tests -D warnings e boundaries passaram. Build do painel reproduziu os assets sem drift; o aviso de chunks grandes é preexistente, sem mudança de limiar. PostgreSQL compartilhado removido após os testes. Não houve nova campanha ou refreeze: apenas testes/docs mudaram; hashes dos ELFs medidos permanecem os mesmos.

O relatório passou a incluir p50/p99 por cenário, sem substituir os quantis pelo resultado agregado. No G10, p99 de login38,685→48,576ms também pede investigação; poucas amostras não permitem atribuir causa. RLS/storage/login continuam falhando no gate p95; o S3 aprovado não os compensa. Sem push, merge ou acesso à VPS.
