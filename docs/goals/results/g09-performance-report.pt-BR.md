# G09 — Revisão técnica de desempenho

Status: execução delimitada encerrada com limitações e gates abertos; nenhuma aprovação global de desempenho.

## Resultado da investigação

Uma otimização foi investigada: interromper consultas de status quando a aba do painel está oculta. Em três repetições controladas de120s, o candidato reduziu as29 chamadas ocultas a zero, preservou12/15/4 chamadas visíveis de updates/host/alertas e fez uma atualização por recurso ao retornar. Chromium, viewport1440×900, pt-BR, respostas sintéticas e relógio/visibilidade controlados. Isso mede chamadas evitadas, não Core Web Vitals, CPU real ou throttling do sistema operacional.

A proposta foi **retirada**. Na comparação completa contra o controle predefinido, o p95 mediano do painel passou de4,628328ms para5,225836ms: **+12,91%**, acima do teto de10%. O controle com o próprio ELF inalterado também variou frente ao baseline antigo (read+21,2%, refresh+48,9%), indicando ruído temporal. A causa da diferença do painel permanece inconclusiva. Não alteramos limites nem selecionamos apenas amostras favoráveis. Uma única sequência A/B/A foi predefinida como diagnóstico adicional; ela não apaga a falha nem recoloca a proposta nesta entrega.

O código de produção final do G09 é o original4d403483. Mantivemos testes de caracterização e uma correção mínima no diagnóstico do executor: um EOF esperado durante o restart explícito fica separado de erros reais do coletor. A primeira calibração que parou por esse motivo foi preservada. A proposta e seus assets continuam no histórico local e em patch/bundle privados.

## Perfil e limites

ELF baseline/final: `2dc5d31029463dddeaa7175efcad2d922529cef2ea482793e8b42f91f3cd4ae0`. Proposta retirada: `aede831cb929408e36c65c7d66a040c01227e87b86de89f99068f65bb6dafc8a`. Rust1.99, release/thinLTO/codegen1. G10 possui outro ELF e validação independente.

Host gerenciado x86_64, cgroup4CPU/32GiB. Aplicação1CPU/128MiB, PostgreSQL1CPU/384MiB/pool8/max40conexões, gerador1CPU/512MiB; S3 local acrescenta1CPU/512MiB. CPUs fixadas separadamente; gerador na mesma máquina e sem exclusividade comprovada do hipervisor/disco. PostgreSQL17.11 em volume de disco, k6 fixado por digest; RustFS1.0.1 real, local/HTTP, não S3 remoto/TLS.

100mil produtos,100mil linhas privadas com50% de seletividade RLS,10mil metadados, arquivos pequenos. Três amostras abertas de60s por cenário a10 iterações/s; refresh/mixed podem emitir login adicional por VU. Não são sempre10 requisições HTTP/s. Throughput estável nessa oferta não mede capacidade máxima. P99 com poucas centenas de requisições é descritivo.

O perfil existente usa cota finita elevada de auth e storageMINFREE0 para isolar o benchmark. Nenhum default do produto mudou; os pisos externos de disco/RAM continuaram ativos. Este perfil não certifica as cotas padrão nem implantação real. O runner interrompe automaticamente por erro de coleta, lacuna de telemetria, OOM, limites de disco/RAM/tempo, autorização ou integridade.

## Evidências adicionais

- SQL:18 EXPLAIN após a carga, em subconjuntos lógicos1k/10k/100k da mesma tabela física100k. Primeira página~0,03–0,04ms; offset profundo mediano0,169/1,687/12,885ms. Não são três bancos de tamanhos diferentes nem prova de paginação O(1). pg_stat_statements inclui seed/warmup/recovery; não prova contagem N+1 por request.
- Painel:7 testes de caracterização passaram antes; a regressão de polling falhou antes e passou na proposta.30 testes de navegador passaram na proposta;72 Vitest passaram/1 skip, com7 testes GC em execução separada. Svelte sem erros/warnings. Esses resultados pertencem à proposta retirada, não são certificação de UX completa.
- SDK TypeScript:297 testes unitários, tipos, build, package, memória/runtime e budgets passaram. Gzip17325/17400(index),9441/9550(rest),11271/11300(auth),7602/7700(storage). Rust SDK:14 testes de transporte. Nenhum SDK alterado; Bun/Deno/outros browsers não executados.
- Rust:10 testes de performance admin,1 memória/cancelamento e10 de alertas CLI passaram; fmt, Clippy workspace/all-targets e boundaries passaram. Uma tentativa filtrou memória para zero: não foi contada; o caso foi executado separadamente.
- Aceitação de host: um teste real com dois projetos Docker, bancos/arquivos isolados, backup/restore/recovery/remoção passou em249,22s (wrapper256,095s). DNS/proveniência/TLS público/proxyreload/extensão PITR não utilizada são doubles. Não é medição isolada de compressão ou validação de reboot/VPS.

## Cobertura e pendências

A matriz P01–P12, hipóteses, comandos e escopo estão no [registro em inglês](../performance-review-execution.md). Backend/SQL/async têm medidas locais e análise de origem, sem otimização especulativa. Cinco/dez projetos com CPUs/reserva próprias, gerador separado, ARM64, S3 remoto/TLS, boot/systemd/VPS e recuperação off-host estão bloqueados pelo ambiente. Renderização de listas grandes, LCP/INP/CLS de campo, profiler detalhado de alocação/tarefas, multipart grande/WAN e custo isolado de estágios CLI não foram executados. G08 permanece separado e incompleto.

## Procedência e prazo

Início original01:33:45 UTC, prazo09:33:45 em23/10/2026. A fase ficou incompleta; houve intervalo entre02:20:56 e11:07:20, de causa não estabelecida, que **não conta como teste**. A pedido do usuário, continuação distinta11:07:20–15:07:20, com30min finais reservados. PostgreSQL de testes ocioso durante a pausa foi removido antes das medições. Não se afirma oito horas de teste efetivo.

Evidências privadas ignoradas: `target/g09/20261023T013345Z` e `target/g09/20261023T110720Z`. Sem push, PR, merge, release, publicação, acesso ou alteração da VPS. Checks locais não substituem CI exato no GitHub. Resultados finais, tempos efetivos e limpeza estão registrados abaixo.

## Comparação completa preservada (proposta retirada)

| Cenário | Controle p95 ms | Proposta p95 ms | Variação | Gate |
| --- | ---: | ---: | ---: | --- |
| read | 4.055834 | 3.402895 | -16.10% | passou |
| rls | 3.399168 | 3.476313 | +2.27% | passou |
| panel | 4.628328 | 5.225836 | +12.91% | FALHOU |
| storage | 8.124890 | 7.833692 | -3.58% | passou |
| login | 28.980586 | 30.834361 | +6.40% | passou |
| refresh | 9.170996 | 9.676743 | +5.51% | passou |
| mixed | 22.742986 | 21.548631 | -5.25% | passou |

Todos os cenários tinham três amostras válidas por lado. Nenhum resultado desta tabela aprova a proposta retirada.

## Diagnóstico A/B/A encerrado

| Rodada | Mediana p95 ms | Dispersão das três amostras ms |
| --- | ---: | ---: |
| panel-control-a | 5.798157 | 5.013051–5.960665 |
| panel-proposal-b | 4.978194 | 4.673730–5.427040 |
| panel-control-c | 4.534052 | 4.482866–4.633681 |

Proposta/controleA=0,8586; proposta/controleC=1,0980; controleC/controleA=0,7820. Todas as comparações isoladas passaram pelo teto original, mas a variação dos controles impede atribuir ganho estável. A falha da campanha completa continua preservada; a retirada é definitiva nesta passada. Não houve nova mudança de produto ou tentativas para selecionar um resultado verde.

## Estabilidade final e tempo efetivo

O ELF original completou1.800s contínuos de carga mista:18.001 iterações/requisições,21.605 checks aprovados, zero checks falhos, erros inesperados ou chegadas descartadas. p50 agregado 2,577ms, p95 21,038ms, p99 29,407ms; distribuições por operação permanecem no JSON. A preparação, três amostras prévias e restart não foram contados nos30min. Fila final0, transações ociosas0, locks0, assinaturas válidas e17 objetos íntegros. As11 conexões antes do teardown incluem pool/worker/coletor legítimos.

161 amostras de recursos: RSS42.024–42.700KiB, final42.452KiB; disco PostgreSQL126–131MiB.68 amostras de SO: FDs20–36(final20), sockets14–30(final14), pipes2, threads4–6(final6). Os contadores estabilizaram durante a carga e caíram após o tráfego. Threads de SO não contam tarefas Tokio; não houve censo completo de alocação/tarefas nem prova geral de ausência de vazamentos.

Tráfego k6 estimado: **152.71min no total**, dos quais124.87min G09 e27.84min G10 independente. Soma de contagem/taxa dos resumos concluídos, incluindo calibração falha preservada; preparação, testes comuns e intervalo ocioso excluídos. Ledger detalhado disponível, sem afirmar oito horas efetivas.

Limpeza verificada: nenhum container em execução, fixture nomeada de benchmark, volume/rede de benchmark ou PostgreSQL compartilhado de testes. Container de desenvolvimento encerrado e volumes anônimos antigos foram preservados; todos os volumes restantes são anteriores à execução. Não houve prune geral.

Prioridades: investigar os gates de latência sem selecionar amostras; obter staging/gerador separado para cobertura bloqueada; tratar o polling em revisão própria futura; concluir G08 separadamente. Correções G10 permanecem em outra branch, com seus próprios gates abertos.

CPU Docker da aplicação ao longo da campanha completa (inclui preparação/recovery): mínimo0,59%, mediana1,86%, máximo99,28% de um núcleo; não é atribuição por operação. Na janela contínua, k6 registrou4.089.021 bytes enviados e55.321.305 recebidos. Contadores de IO e limites brutos permanecem em resources.jsonl; NetIO do Docker em host-network não mede esse tráfego HTTP.

## Complemento da revisão: p50 e p99

Medianas dos três quantis por amostra, em ms; não são quantis de uma distribuição combinada. Perfil completo de disco já registrado acima.

| Cenário | Controle p50 | Candidato p50 | Controle p99 | Candidato p99 |
| --- | ---: | ---: | ---: | ---: |
| read | 2.230 | 2.091 | 6.401 | 5.608 |
| rls | 2.271 | 2.245 | 5.529 | 5.443 |
| panel | 3.138 | 3.249 | 7.200 | 7.210 |
| storage | 3.126 | 3.129 | 14.727 | 11.085 |
| login | 22.314 | 24.332 | 38.685 | 39.230 |
| refresh | 4.527 | 4.611 | 26.397 | 25.527 |
| mixed | 2.523 | 2.408 | 28.865 | 27.509 |

## Revisão posterior

Revisão completa dos diffs de produção/testes, alteração mínima do sampler, retirada da otimização, relatórios e integridade do pacote anterior. Nenhum novo defeito de produção confirmado nesta revisão. A aprovação de desempenho continua bloqueada; os resultados anteriores não foram repetidos nem reescritos.

Lacuna corrigida: o teste de provedor usava uma variável para alternar JSON, então o cargo test comum cobria só texto. Agora dois executáveis de integração executam texto/JSON automaticamente, com casos compartilhados. A asserção de e-mail espera especificamente kind=recovery; signup nesta fixture não enviava confirmação, portanto não foi demonstrada uma race no teste anterior. O caso JSON valida as linhas e o caso de delete diferido também exige a presença do diagnóstico. Commit de testes2c6017f8; sem dependências/workflows novos.

Verificação posterior:9 testes Rust (7 HTTP/banco +1 provedor texto +1 provedor JSON),2 testes Chromium retidos após o revert, fmt, Clippy server/tests -D warnings e boundaries passaram. Build do painel reproduziu os assets sem drift; o aviso de chunks grandes é preexistente, sem mudança de limiar. PostgreSQL compartilhado removido após os testes. Não houve nova campanha ou refreeze: apenas testes/docs mudaram; hashes dos ELFs medidos permanecem os mesmos.

O relatório passou a incluir p50/p99 por cenário, sem substituir os quantis pelo resultado agregado. No G10, p99 de login38,685→48,576ms também pede investigação; poucas amostras não permitem atribuir causa. RLS/storage/login continuam falhando no gate p95; o S3 aprovado não os compensa. Sem push, merge ou acesso à VPS.
