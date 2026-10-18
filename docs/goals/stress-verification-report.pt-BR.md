# G05 — relatório técnico final em português

Campanha encerrada em **18/10/2026, 04:31:10 UTC**, **sem aprovação integral do G05**. As quatro etapas da diretriz de convergência receberam veredicto. Não haverá novas campanhas, correções automáticas, repetições ou congelamentos nesta execução. O limite absoluto permaneceu 19/10/2026, 03:27:36 UTC; o encerramento ocorreu antes dele. Nenhum deploy ou merge de produção foi realizado.

O [PR #91](https://github.com/Nelcota/Nelcota/pull/91) está aberto e pronto para revisão, com as onze correções de produção, regressões e rebuilds necessários, **18/18 checks ordinários aprovados no SHA exato**. O [PR #90](https://github.com/Nelcota/Nelcota/pull/90) continua **draft** e preserva o harness e as evidências. A aprovação do CI não substitui os gates de stress que falharam ou não executaram.

## Artefato, procedência e ambiente

- Fonte de produção: `5b2b2a49f60274456e84fc027fd3e401fd64e417`; ELF SHA-256: `b59d2c15fcf12d90e0ad01b13f5bbaa73c73eabe9a302d9a05186b26c15c630e`, 30.484.800 bytes.
- Único congelamento: 17/10/2026, 21:51:46 UTC; [manifesto](results/stress/campaign-final-artifact.json) e [ambiente do build](results/stress/campaign-final-build-environment.json). Rust 1.99.0, `x86_64-unknown-linux-gnu`, release com lockfile, thinLTO/codegen 1 e quatro jobs. O build exato reutilizou cache; não se afirma rebuild limpo ou reprodutibilidade byte a byte entre hosts.
- Todos os casos finais usaram esses mesmos bytes, inclusive a VM remota. O wrapper de transporte `13351ed` e os SHAs dos snapshots do harness identificam ferramentas, não outra fonte de produção. As cinco diferenças de testes entre o checkout G05/615a0a0 e a extração são declaradas no manifesto; o produto executado veio da extração aprovada.
- Staging descartável, cinco CPUs visíveis/quota efetiva de quatro e 32 GiB de RAM. No perfil ordinário: app 1 CPU/128 MiB, PG 1 CPU/384 MiB, gerador 1 CPU/512 MiB, métricas 0,25 CPU/512 MiB; S3 acrescenta RustFS 0,5 CPU/1.024 MiB. Reservas originais: 10% RAM e 15% bytes/inodes. CPU, tráfego, duração e watchdogs permanecem limitados pelos manifestos.
- Disco real do filesystem de staging, 100 mil linhas públicas e 100 mil privadas, objetos de 17 bytes no workload ordinário e inventário físico de 10 mil objetos iniciais. S3 real significa RustFS compatível com S3 no staging local; não AWS, Internet pública ou WAL/PITR. O perfil de falhas tem quotas próprias declaradas e não é comparado como equivalente ao ordinário.

## Veredicto das quatro etapas

| Etapa | Veredicto | Evidência e alcance |
|---|---|---|
| a — fence após reboot da convidada | **failed** | [Probe](results/stress/native-reboot-converged-verdict.json): PG, app e API autenticada reabriram antes de recuperação explícita. P12 aberto. Linhas preservadas, canários 401/RLS0/arquivo 404 e limpeza confirmados. |
| b — endurance em disco | **passed** | [14.400 s contínuos](results/stress/disk-converged-final-001.json), mesmos processos, contadores fechados e limpeza; [oito comparações aprovadas](results/stress/disk-converged-final-001-comparison.json). |
| c — endurance S3 real | **failed** | [Tentativa 001](results/stress/s3-converged-final-001-platform-interruption.json) interrompida pelo reboot do ambiente; [tentativa 002](results/stress/s3-converged-final-002-failed.json) parou por fork EAGAIN no coletor, antes do endurance. Zero crédito de quatro horas S3, limpeza confirmada. |
| d — falhas simples sob carga | **passed** | [Perfil existente](results/stress/fault-converged-final-001.json), uma falha por vez, ACKs reconciliados, restore local e recuperação; limpeza confirmada. |

O instante 0,405 s registrado em a pertence à primeira observação **após boot/readiness da VM**; não é RTO desde o corte. O adaptador de erro escreve apenas um marcador de fixture e não restaura WAL real. A reabertura é um defeito operacional confirmado; não houve escape de autorização/RLS ou perda/corrupção de ACKs comprovados nessa fixture. Pela diretriz, P12 foi registrado e permaneceu aberto.

## Tempo efetivo

O [checkpoint 021](results/stress/load-time-checkpoint-021.json) registra um piso conservador de **182.594 s = 50 h 43 min 14 s** de carga efetiva concluída ao longo da execução G05. Ele mantém 162.324 s históricos, acrescenta 18.690 s do disco final e 1.580 s de falhas finais, sem dupla contagem remota. Preparação, aquecimento, descanso e intervalos incompletos ficam excluídos.

No artefato final, os dois perfis aprovados somam **20.270 s = 5 h 37 min 50 s**, incluindo **4 h contínuas em disco e 0 h de endurance S3 aprovado**. As fases fechadas parciais de S3 preservam 510 s e 810 s adicionais, mas não foram somadas ao piso acima. O contador bruto do disco 18.705 inclui 15 s de warmup; a errata H04 registra a exclusão. O mínimo global de oito horas foi superado historicamente; isso não aprova o requisito final disco+S3 nem as duas passagens independentes.

## Disco: capacidade, latência e integridade

A qualificação aberta sustentou **400 iterações/s durante 300 s**, no teto de calibração declarado. Trata-se de limite inferior qualificado, não capacidade máxima ou taxa de ruptura. O endurance ofereceu 280 iterações/s (70%). A mediana 805,73 iterações/s do teste fechado é auxiliar, não substitui a qualificação aberta. Foram 4.032.001 iterações/operações úteis, 4.035.938 HTTP físicos e 3.937 rejeições negativas esperadas, zero chegadas perdidas e zero erros inesperados. Iterações e requisições HTTP são unidades distintas.

| Operação no soak misto | p95 (ms) | p99 (ms) |
|---|---:|---:|
| read | 4.666 | 9.216 |
| rls | 3.865 | 9.171 |
| panel | 4.136 | 7.971 |
| storage | 12.054 | 20.243 |
| login | 35.921 | 46.786 |
| refresh | 13.823 | 19.281 |
| write | 10.092 | 15.314 |

As latências usam apenas respostas bem-sucedidas e o protocolo de requisição lógica completa. O workload `panel` mede HTTP administrativo, não feedback visual do navegador. Os SLOs absolutos e os gates relativos originais foram preservados.

| Steady, mediana de três execuções | p95 baseline (ms) | p95 final (ms) | Razão throughput útil | Veredicto |
|---|---:|---:|---:|---|
| read | 16.847 | 14.874 | 1.144 | passed |
| rls | 18.991 | 15.366 | 1.190 | passed |
| panel | 28.804 | 26.930 | 1.067 | passed |
| storage | 58.440 | 56.740 | 1.066 | passed |
| login | 350.339 | 313.261 | 1.103 | passed |
| refresh | 30.276 | 26.671 | 1.127 | passed |
| write | 10.083 | 5.427 | 1.000 | passed |
| mixed | 76.667 | 66.578 | 1.168 | passed |

Todas as oito comparações são equivalentes pelo comparador existente, gates p95<=1,10 x e throughput útil>=0,90 x. Os resultados preservam variação observada; não demonstram ganho causal atribuído a uma correção específica.

Integridade: 259.229 eventos únicos e entregas reconciliados, zero ausentes/extras/duplicatas, zero erros de assinatura,129 objetos verificados e nenhum key não referenciado no inventário. Censo final: 100 mil linhas públicas,100 mil privadas e 10.129 metadados de storage. Duas coortes foram efetivamente removidas pelos pruners; a sessão canário renovou 16 vezes.

## Recursos e recuperação

Disco: 3.326 amostras, maior lacuna 11,6 s(inferior ao gate 30 s), pico RSS do app 50.768 KiB e pico durante soak 48.356 KiB. Os seis censos de descanso retornaram 24 FDs/4 tarefas/18 sockets;15 conexões PG, zero transações idle abertas e zero locks aguardando. O último drain levou 0,075591 s. Não houve OOM observado no disco.

Isso evidencia liberação dos donos de SO medidos. Não atribui todo heap ou memória anônima a donos vivos e não prova ausência absoluta de vazamentos. O4 permanece aberto. Cache PG/RustFS, memória anônima e retenção do alocador são distinguidos nos recibos. Séries completas fechadas foram [compactadas sem perda](results/stress/disk-converged-final-001-resource-archive.json), com SHA de reconstrução; a [série de falhas](results/stress/fault-converged-final-001-resource-archive.json) tem o mesmo tratamento.

Falhas: quatro degraus 300 s em 16/32/48/64 iterações/s, qualificação 64 e carga 51 iterações/s (79,6875%). Foram 65.945 tentativas,58.826 ACKs e 62.092 commits; zero ACKs ausentes e zero desconhecidos/corrompidos. Todas as 3.266 respostas descartadas após COMMIT real foram reconciliadas. Não houve retry automático de mutações; a identidade/PK é explícita da fixture, sem promessa genérica de exactly-once.

Banco indisponível, deadlock, kill do app, OOM declarado em 8 MiB, ENOSPC de bytes/inodes e restart/pause do RustFS foram exercitados sequencialmente. O OOM foi intencional e limitado ao app próprio; não se afirma zero OOM nesse perfil. Bytes/inodes usaram tmpfs próprio de 16 MiB, sem preencher o disco do host. Recursos tiveram 312 amostras, maior lacuna 13,247 s e zero violações finais.

Restore local: pg_dump com escritores ativos e arquivos imutáveis, alvo novo, RTO 2,5298 s e limite superior de RPO 18,0006 s. A diferença 867 linhas é rewind intencional ao snapshot; não desaparecimento de ACKs na origem. Contabilidade, identidade de usuário, token cruzado 401 e bytes restaurados passaram. Não prova backup com arquivos mutáveis, WAL/PITR ou off-host. O provedor recuperou em 0,5574 s após restart e 0,0519 s após unpause, com leitura/escrita verificadas e canário 401, dentro do gate 35 s.

## S3: falhas preservadas

A API cloud retornou 409 environment_offline; na volta, o uptime era 35,8 s, os donos antigos haviam desaparecido e os serviços próprios estavam parados exit 255. A tentativa 001 encerrou em `panel-2`, antes do endurance. Antes da limpeza externa restrita, diagnósticos e os três volumes foram arquivados privadamente. A causa do reboot da plataforma não foi determinada.

Uma única tentativa de infraestrutura 002 repetiu a mesma etapa, com os mesmos argumentos, ELF e limites, sem novo recurso no harness. Ela falhou em `login-1`: `exec sh: can't fork: Resource temporarily unavailable` na amostragem de orçamento de disco, novamente no teardown. O host mostrou pids.events max 2 após o encerramento; os últimos censos por componente não atribuem a origem da exaustão. O6 permanece aberto, sem inferir defeito de produto. O guard parou a carga e confirmou limpeza. Nenhum limite foi aumentado, nenhum dado faltante foi convertido em aprovação e não houve nova tentativa S3.

## Onze correções de produção extraídas

Os resultados antes/depois abaixo são reproduções focadas, históricas e preservadas; o CI atual do SHA 5b2b2a4 validou suas regressões. Eles não substituem as campanhas finais que faltaram.

| Commit no PR 91 | Antes reproduzido | Depois e evidência |
|---|---|---|
| `0f93b74` | Administração podia alterar o cluster sentinela com layout 17/main incompatível. | Preflight e clientes presos ao cluster/socket/porta esperados; senha por stdin. [Antes](results/stress/native-postgres-collision-before.json)/[depois](results/stress/native-postgres-collision-after.json). |
| `19e5af9` | Diretório relativo produzia unit inválida e loop de reinícios. | Root absoluto antes de provisionar. [Antes](results/stress/native-default-root-before.json)/[depois](results/stress/native-default-root-after.json). |
| `07ae417` | Outro diretório podia tomar a instalação; teardown podia perder owner. | Lease de máquina e owner persistente até remoção completa. [Antes](results/stress/native-host-root-before.json)/[depois](results/stress/native-host-root-after.json). |
| `d25c3a7` | Subprocesso nativo usava cwd incorreto/reentrava no lease de migração. | Contexto explícito do projeto. [Antes](results/stress/native-cwd-migration-before.json)/[depois](results/stress/native-cwd-migration-after.json). |
| `2996dbd` | Remoção declarava sucesso apesar de configuração de backup não removida. | Preflight e erro propagado preservam owner/runtime. [Antes](results/stress/native-remove-boundary-before.json)/[depois](results/stress/native-remove-boundary-after.json). |
| `4aaaa20` | Cancelamento SQL liberava admission antes do backend terminar. | Permit retido até cleanup. [Antes](results/stress/sql-cancellation-admission-before.json)/[depois](results/stress/sql-cancellation-admission-after.json). |
| `669548e` | Export cancelado tinha a mesma liberação prematura. | Cleanup conserva admission; teste espera Execute real no prazo original. [Antes](results/stress/export-cancellation-admission-before.json)/[depois](results/stress/export-cancellation-admission-after.json). |
| `1b509ca` | Linha grande de export sem consumo escapava do prazo de resposta. | Deadline fecha a conexão e libera recursos. [Antes](results/stress/export-large-unpolled-deadline-before.json)/[depois](results/stress/export-large-unpolled-deadline-after.json). |
| `c94d0dd` | Refresh tardio sobreposto causava rotações extras. | Browser coalesce a rotação já concluída. [Antes/depois](results/stress/sdk-native-overlapping-refresh-before-after-001.json). |
| `6ab1ef4` | Clientes server com memória independente bloqueavam na mesma fila. | Filas próprias; storage explicitamente compartilhado continua coordenado. [Antes/depois](results/stress/sdk-independent-server-clients-built-before-after-001.json). |
| `eeb2468` | Erro PITR incerto reabria serviços imediatamente. | Mantém PG/app parados no caminho imediato. [Antes](results/stress/pitr-error-rust-regression-before-001.json)/[depois](results/stress/pitr-error-rust-regression-after-001.json). A persistência após boot continua defeituosa P12. |

O PR 91 contém 15 commits: as onze correções acima, fixture de credencial gerada `ae93b2b`, repetição CI de cancelamento `1b6c5aa`, assets/guias reconstruídos `b1c3b12` e filtro CI `5b2b2a4`. [Lista completa](results/stress/production-extraction-commits.json) e [mapa de extração](results/stress/production-fix-extraction-map.json). Bench, harness e documentos G05 foram excluídos dessa branch, criada da main 2 efede 8.

Validação local da extração: 93 testes CLI aprovados/um ignorado e 85 testes SDK nos dois arquivos focados; fmt, boundaries, traduções e build de assets passaram. O ignorado local não é contado como aprovado. [CI 18/18](results/stress/ci-production-extraction-5b2b2a4.json) corresponde ao SHA exato; regressões de SQL/export fazem parte dos checks reais. Os controles locais do probe somam 55 casos e os do verificador de artefatos cinco,**60 únicos**, sem somar repetições como casos novos.

## Células bloqueadas por ambiente

Todas permanecem **blocked (environment)**, sem workaround ou nova tentativa e com SLOs/reservas intactos. Os [perfis integrais](results/stress/campaign-convergence-policy.json) foram declarados antes das campanhas finais.

| Célula | Staging necessário |
|---|---|
| Restore off-host | Duas máquinas isoladas, transporte privado cifrado e destino novo com dataset, temporários e reservas. |
| WAL/PITR real pgBackRest/S3 | PG 17/pgBackRest reais, repositório S3 TLS, WAL retido, testemunha de ACKs e destino novo com janela completa de replay. |
| DNS/ACME/TLS público | Domínio/endereço próprios, autoridade DNS,80/443 e ciclo real de emissão/renovação. |
| ARM 64 | Linux ARM 64 nativo, toolchain/imagens compatíveis e orçamento original de CPU/RAM/disco. |
| Gerador em outra máquina | Host gerador independente, rede controlada e capacidade demonstrada acima da oferta. |
| Host com dez projetos | Dez fixtures independentes e disco adicional; a última projeção exige 16.062.994.022,4 bytes livres incluindo reserva, mais headroom de crescimento/telemetria. |
| Ensaio 24 h | Reserva ininterrupta de 24 h medidas, mais preparação/limpeza, com observador e armazenamento próprios. |
| Perda de energia além do corte de VM | Hardware/aparato isolado de energia/storage e testemunha externa durável de ACKs; kill de QEMU não comprova mídia física. |

## Situação dos doze critérios originais

| # | Critério | Veredicto | Alcance/impedimento |
|---|---|---|---|
| 1 | Inventário, baseline imutável e SLOs | **passed** | Inventário e manifestos presentes; células obrigatórias mantêm seus limites. |
| 2 | Calibração, unidades, amostragem e validade da evidência | **passed** | Qualificação de 400 iter/s em disco e 64 iter/s nas falhas; contadores fechados e gates intactos. A observação S3 falhou de forma explícita. |
| 3 | Cancelamento, watchdogs, redação e limpeza própria | **passed** | Perfis executados pararam em limites e limparam seus recursos; o reboot exigiu reconciliação externa documentada. |
| 4 | Duas passagens finais independentes de steady, escada, picos e descanso | **not run** | Somente uma campanha final em disco concluiu; artefatos históricos diferentes não suprem esta repetição. |
| 5 | Toda a matriz de capacidades, segurança e concorrência | **not run** | Células amplas não executaram na sequência limitada por convergência. |
| 6 | Isolamento/fairness/controller de 1/5/10 projetos | **blocked (environment)** | Dez projetos sem disco/reserva suficientes; falhas históricas com cinco projetos continuam abertas. |
| 7 | Quatro horas contínuas em disco e S3 no artefato final | **failed** | Disco 14.400 s aprovado; S3 sem crédito de endurance. |
| 8 | Falhas, recuperação, restore e deployment | **failed** | Falhas simples locais passaram; fence nativo falhou; off-host/PITR/TLS público bloqueados. |
| 9 | Donos de recursos, integridade e gates de regressão | **failed** | Integridade em disco/falhas passou; observação S3 falhou e atribuição completa do alocador permanece aberta. |
| 10 | Todos os defeitos confirmados corrigidos com regressões | **failed** | Onze de doze defeitos de produção corrigidos; P12 permanece aberto por decisão de convergência. |
| 11 | Rust/UI/SDK/lint nativo e CI ordinário no SHA testado | **passed** | PR 91: 18/18 checks no SHA 5b2b2a4, conferidos em 18/10, 04:28 UTC; fence em runtime é uma célula separada e falha. |
| 12 | Relatório, limites e falhas/bloqueios/não executados | **passed** | Quatro etapas, oito bloqueios, achados abertos e todos os gates incompletos registrados. |

Os requisitos não foram reduzidos. O G05 permanece aberto para aprovação; a campanha autônoma foi encerrada por convergência. Os checks de repetição, matriz ampla, S3, endpoints operacionais e correção de P12 não estão marcados como cumpridos.

## Matriz completa: situação no artefato final

`passed` nesta tabela é restrito ao perfil e à fixture descritos. `not run` significa que a célula completa não foi demonstrada, mesmo quando um subconjunto funcional passou. [Inventário e veredictos estruturados](results/stress/campaign-final-verdicts.json).

| Área | Veredicto | Alcance |
|---|---|---|
| Autenticação | **not run** | Login/refresh e negativos passaram no workload de disco; recuperação, links e dois consumidores não foram exercitados na matriz completa final. |
| REST, RPC, RLS e estatísticas | **not run** | Subconjunto de 100 mil linhas passou; matriz completa com 1 milhão/RPC/estatísticas não executada no artefato final. |
| Mutações e respostas ambíguas | **passed** | Perfil local limitado de transferências atômicas, contenção, entradas inválidas/duplicadas, deadlock e reconciliação de COMMIT passou. |
| Catálogo, DDL e refresh | **not run** | Concorrência completa de DDL, migração e recuperação de refresh não executada. |
| Storage em disco | **not run** | Endurance com objetos pequenos e ENOSPC próprio passaram; matriz completa Unicode/paths/colisões/objetos grandes/clientes lentos não executada. |
| Storage S3 real e multipart | **failed** | Endurance não começou; restart/pause do provedor passaram em D; multipart/endurance longo sem aprovação. |
| Webhooks | **not run** | 259.229 identidades assinadas reconciliadas em disco; matriz completa de retries, chaves e leases não executada. |
| Admin, SQL e exports | **not run** | Regressões focadas de cancelamento passaram no CI da fonte; stress completo concorrente não executado. |
| Navegador e painel | **not run** | Workload HTTP administrativo não mede feedback/timers/listeners do navegador; sem campanha browser no ELF final. |
| SDKs TypeScript/Rust | **not run** | Regressões focadas passaram; stress completo de runtimes/browser no artefato congelado não executado. |
| Topologias 1/5/10 | **blocked (environment)** | Subconjunto de um projeto passou; dez bloqueados; falhas históricas de fairness com cinco continuam abertas. |
| Gestão do host | **not run** | Stress completo de lifecycle, recibos e limites de admissão não executado. |
| Updates e compatibilidade | **not run** | Stress completo de ativação/interrupção/compatibilidade não executado. |
| Snapshot e restore local | **passed** | pg_dump sob escritores, alvo novo, contabilidade, token cruzado e bytes imutáveis passaram; rewind ao snapshot explicitamente limitado. |
| Entradas hostis e ingress | **not run** | Subconjunto 400/403/401 passou; matriz completa de entradas malformadas, clientes lentos, churn e ingress não executada. |
| Deployment nativo/público/energia | **failed** | Fence final após reboot falhou P12; TLS público e perda física de energia bloqueados. |
| Off-host e WAL/PITR | **blocked (environment)** | Sem tentativa off-host ou WAL/PITR real; perfis de staging continuam necessários. |
| ARM 64 | **blocked (environment)** | Sem staging ARM 64 nativo; sem retry/workaround. |

## Achados abertos e correções mínimas do executor

P12 é o décimo segundo defeito de produção confirmado; onze foram corrigidos. Os demais itens abaixo são observações abertas, sem causa de produto confirmada quando assim classificados.

| ID | Situação |
|---|---|
| P12 | Fence PITR não persiste após reboot; PG/app/API reabriram. Sem correção, novo freeze ou restart automático. |
| O1 | Falha histórica de startup nativo continua sem causa; oito reproduções posteriores aprovadas não a apagam. |
| O2 | Falha histórica do SLO de refresh no navegador continua sem causa; passes posteriores não a apagam. |
| O3 | Falhas históricas de fairness/p95 em cinco projetos sob CPU compartilhada permanecem; sem campanha extra. |
| O4 | Atribuição incompleta da memória anônima do app e do alocador RustFS; RSS isolado não conclui vazamento nem sua ausência. |
| O5 | Diagnóstico 018 viu executável/unit zerados após corte; causa e vínculo com durabilidade do produto seguem incertos. Sync da fixture não prova correção da instalação. |
| O6 | Fork EAGAIN do coletor S3; componente/causa não atribuídos. Tentativa falha preservada, sem aumentar limites. |

O [ledger](results/stress/campaign-convergence-findings.json) preserva evidências e ações. Após o congelamento, nenhum produto foi corrigido. H01 é o sync limitado da fixture antes do corte para tornar o probe válido; H02 corrige a contagem 60(original assert incorreto preservado); H03 configura o transporte do ELF existente; H04 corrige a exclusão do warmup; H05 corrige somente a projeção do relatório de falhas(`monotonic` em vez de `elapsed`). Nenhum deles flexibiliza gates. A interrupção da plataforma é I01, sem causa raiz estabelecida.

## Limites, dimensionamento e encerramento

O envelope aprovado restringe-se a um projeto local,100 mil linhas por tabela e objetos pequenos, com CPU/RAM/reservas acima. Uma VPS deve reservar também SO, PG, WAL, logs, backups, proxy/controller e crescimento; não há evidência para recomendar a mesma densidade a dez projetos ou tratar 400 iterações/s como capacidade máxima. Os testes não aprovam TLS público, ARM 64, gerador remoto, PITR real, off-host ou energia física.

Não houve disparo confirmado da exceção crítica de escape de autorização/RLS, perda de ACKs ou corrupção. Todos os recursos próprios iniciados foram removidos com recibo; a tentativa interrompida foi reconciliada externamente após preservar diagnósticos. Contêineres alheios permaneceram no estado observado; não houve prune global. Segredos, dumps, volumes, SQL privado e payloads ficam somente em `target/stress-g05/`, fora do Git.

O [relatório de trabalho anterior](stress-verification-report-history.pt-BR.md) foi preservado byte a byte com [checksum](results/stress/report-history-preservation.json); suas datas, aprovações retiradas e estados pendentes são históricos. O [registro completo](stress-verification-execution.md) mantém os checkpoints e falhas originais. As tentativas afetadas por contadores antigos incompletos não foram promovidas a aprovação atual.

O pedido posterior G06 foi recebido e preparado separadamente. Sua fase 1 e seu prazo 24 h não começaram: o próprio goal exige um SHA fixo da main depois do merge das correções G05, e PR 91 continua aberto. Esse pedido não modificou o artefato G05 nem acrescentou campanhas. Não haverá merge automático.
