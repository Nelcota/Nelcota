const ptBR = {
  title: "Alertas",
  description:
    "Avisos de operação enviados pelo serviço de monitoramento, mesmo com o painel fechado.",
  reload: "Recarregar configuração",
  loading: "Consultando monitor…",
  loadFailed: "Não foi possível consultar o monitor. Verifique a conexão e tente novamente.",
  staleForm:
    "A configuração mudou enquanto você editava. Recarregue antes de revisar outra alteração.",
  never: "Ainda não registrado",
  activeCount: { one: "{count} incidente ativo", other: "{count} incidentes ativos" },
  noConfirmed: "Sem incidentes confirmados",
  disabled: "Monitor desativado",
  observerStale: "Aguardando uma verificação recente do serviço de monitoramento",
  observerFailed: "Há verificações indisponíveis; consulte os incidentes",
  stateUnavailable:
    "O estado persistido dos alertas está indisponível. Envios automáticos e sinais de vida estão suspensos; preserve os arquivos e solicite a recuperação ao administrador.",
  maintenance: "Operação do host em andamento; verificações dos projetos suspensas",
  lastScan: "Última verificação concluída",
  heartbeatAccepted: "Último sinal de vida aceito pelo destino",
  lastDelivery: "Último envio aceito",
  retry: "Nova tentativa a partir de",
  email: "E-mail",
  webhook: "Webhook HTTPS",
  heartbeat: "Monitor externo",
  externalTitle: "Queda total da VPS exige um observador externo",
  externalRequired:
    "Se a VPS, o serviço de monitoramento ou a rede pararem, este processo também para. Cadastre o sinal de vida em um serviço independente para receber esse tipo de aviso.",
  externalSetup:
    "Configure o serviço externo com período de 1 minuto e tolerância mínima de 4 minutos. O endpoint precisa aceitar POST HTTPS sem redirecionar. Teste a ausência de pings em staging e confirme o recebimento do aviso; um ping aceito não comprova a entrega de alertas externos.",
  incidents: "Incidentes de operação",
  host: "Servidor",
  warning: "Atenção",
  critical: "Crítico",
  recovered: "Recuperado",
  changed: "Última mudança",
  enable: "Ativar alertas automáticos",
  scope:
    "Configuração do host inteiro: monitora todos os projetos registrados. A aplicação e o banco não são reiniciados por esta alteração.",
  emailEnable: "Enviar resumo por e-mail",
  smtpProject: "Projeto que fornece a configuração SMTP",
  recipient: "Operador destinatário",
  select: "Selecione",
  smtpNotice:
    "Usa o SMTP com TLS já salvo no projeto escolhido, sem depender de a aplicação estar no ar. O destinatário precisa ser um operador com permissão de gestão do host.",
  webhookEnable: "Enviar resumo para webhook",
  webhookUrl: "Nova URL privada do webhook",
  heartbeatEnable: "Enviar sinal de vida (heartbeat) a um observador externo",
  heartbeatUrl: "Nova URL privada do sinal de vida",
  currentHost: "Host do destino atual",
  notConfigured: "Não configurado",
  privateUrls:
    "As URLs completas não retornam ao navegador. Deixe em branco para preservar o destino salvo.",
  webhookNotice:
    "Envia o JSON de incidentes da Nelcota, com identificador de entrega para deduplicação. Serviços de mensagens podem exigir um adaptador para esse formato. O hostname do destino precisa de autorização inicial do controlador.",
  diskPercent: "Avisar abaixo de espaço livre (%)",
  diskGib: "Avisar abaixo de espaço livre (GiB)",
  certDays: "Avisar antes do vencimento do certificado (dias)",
  backupHours: "Idade máxima do backup bem-sucedido (horas)",
  reminderHours: "Intervalo mínimo entre lembretes (horas)",
  confirmationPolicy:
    "Verifica a cada minuto: três amostras com falha confirmam o incidente; duas amostras boas confirmam a recuperação. O disco também respeita a reserva mínima do host. Uma leitura indisponível não encerra um incidente. Mudanças de configuração reiniciam essa janela de confirmação.",
  preview: "Validar e revisar alertas",
  test: "Testar envio de alertas",
  testNotice:
    "O teste usa a configuração já salva e exige confirmação. Confirma a aceitação pelo transporte, não a chegada à caixa de entrada. A recuperação de uma tentativa incerta pode reenviar a mensagem.",
  application: "Aplicação",
  database: "PostgreSQL",
  https: "HTTPS e saúde pública",
  certificate: "Vencimento do certificado",
  disk: "Espaço em disco",
  backup_late: "Backup atrasado ou ainda sem sucesso registrado",
  backup_failed: "Backup com falha ou interrompido",
  monitoring: "Verificação de operação indisponível",
  alert_delivery_failed:
    "Falha no envio. Revise a configuração e teste o canal; haverá nova tentativa com intervalo crescente.",
  alert_heartbeat_failed: "Sinal de vida não aceito. Verifique o destino e o monitor externo.",
  invalid_alert_limits: "Confira os limites de disco, certificado, backup e lembretes.",
  alert_channel_required: "Ative pelo menos e-mail ou webhook para receber incidentes.",
  invalid_alert_recipient: "Selecione um operador autorizado como destinatário.",
  alert_email_project_changed:
    "O projeto que fornece SMTP mudou de identidade. Selecione-o e revise novamente a configuração.",
  invalid_alert_endpoint:
    "Use um endpoint HTTPS aprovado, sem usuário, senha ou fragmento na URL. Destinos de rede privada são recusados.",
  alert_endpoint_required: "Informe a URL privada do destino ou preserve uma já configurada.",
  invalid_alert_configuration: "A configuração dos alertas é inválida. Revise os campos.",
  alerts_not_configured: "Salve e ative os alertas antes de testar o envio.",
};

export default ptBR;
