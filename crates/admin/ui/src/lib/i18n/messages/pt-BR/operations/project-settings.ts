import type { ProjectSettingKey } from "$lib/generated/contracts";

const fields = {
  email_language: {
    label: "Idioma dos emails",
    hint: "Padrões em inglês ou português. Modelos personalizados são preservados; revise-os ao trocar o idioma.",
  },
  email_recovery_subject_base64: {
    label: "Assunto de recuperação",
    hint: "Texto de uma linha, até 200 bytes UTF-8. Variáveis: {{project_name}} e {{validity}}; nunca tokens ou destinatários no assunto.",
  },
  email_recovery_text_base64: {
    label: "Mensagem de recuperação",
    hint: "Texto simples com até 2.048 bytes UTF-8 e exatamente um {{link}}. Quebras de linha são preservadas sem interpretação pelo shell.",
  },
  email_signup_subject_base64: {
    label: "Assunto de confirmação",
    hint: "Texto de uma linha, até 200 bytes UTF-8. Usar o padrão acompanha o idioma selecionado.",
  },
  email_signup_text_base64: {
    label: "Mensagem de confirmação",
    hint: "Texto simples com até 2.048 bytes UTF-8 e exatamente um {{link}}. Não aceita HTML executável ou variáveis desconhecidas.",
  },
  email_magiclink_subject_base64: {
    label: "Assunto do link de acesso",
    hint: "Texto de uma linha, até 200 bytes UTF-8. Usar o padrão acompanha o idioma selecionado.",
  },
  email_magiclink_text_base64: {
    label: "Mensagem do link de acesso",
    hint: "Texto simples com até 2.048 bytes UTF-8 e exatamente um {{link}}. O link continua sendo de uso único.",
  },
  email_recovery_ttl_minutes: {
    label: "Validade da recuperação (minutos)",
    hint: "De 5 a 1.440 minutos. Aplica-se somente aos novos links; não altera os já emitidos.",
  },
  email_signup_ttl_minutes: {
    label: "Validade da confirmação (minutos)",
    hint: "De 5 a 10.080 minutos. Aplica-se somente aos novos links; não desabilita a confirmação de email.",
  },
  email_magiclink_ttl_minutes: {
    label: "Validade do link de acesso (minutos)",
    hint: "De 1 a 60 minutos. Este link autentica por si só; mantenha uma validade curta.",
  },
  signup_enabled: {
    label: "Cadastro público",
    hint: "Permite criar contas. Desabilitar não bloqueia contas já existentes.",
  },
  jwt_expiry_secs: {
    label: "Validade do token de acesso (segundos)",
    hint: "Aplica-se aos novos tokens. Não revoga tokens que já foram emitidos.",
  },
  refresh_token_ttl_days: {
    label: "Validade da renovação de sessão (dias)",
    hint: "Aplica-se à emissão e à próxima rotação do token de renovação.",
  },
  auth_rate_limit_per_minute: {
    label: "Requisições de autenticação por minuto",
    hint: "Limite por IP para login e cadastro. A confiança no proxy continua sendo controlada pelo host.",
  },
  api_rate_limit_per_minute: {
    label: "Requisições de API por minuto",
    hint: "Limite por usuário autenticado ou IP para REST e arquivos. Zero desabilita; service_role e downloads públicos ou assinados são isentos.",
  },
  cors_allow_origins: {
    label: "Origens CORS permitidas",
    hint: "Uma origem HTTP(S) exata por linha, sem caminho, barra final ou credenciais. O padrão permite qualquer origem; uma lista vazia não permite acesso por navegadores de outras origens. Não substitui autenticação/RLS nem libera acesso ao painel. Pré-verificações podem ficar em cache por duas horas.",
  },
  max_rows: {
    label: "Máximo de linhas por consulta REST",
    hint: "O padrão é 1.000. Não altera os limites de segurança do editor SQL.",
  },
  max_body_bytes: {
    label: "Corpo máximo de requisição REST (bytes)",
    hint: "O corpo é carregado em memória. Não controla o tamanho dos uploads de arquivos.",
  },
  api_concurrency_per_caller: {
    label: "Consultas REST simultâneas por cliente",
    hint: "O padrão usa metade do pool, com mínimo de uma. Zero desabilita o limite; valores explícitos não podem superar o pool.",
  },
  db_pool_size: {
    label: "Conexões no pool da API",
    hint: "Aumentar consome recursos do PostgreSQL. Não reinicia o banco; confira a capacidade do host.",
  },
  request_timeout_secs: {
    label: "Prazo da requisição REST (segundos)",
    hint: "Precisa ser maior que o prazo da consulta quando este estiver habilitado.",
  },
  statement_timeout_secs: {
    label: "Prazo da consulta SQL da API (segundos)",
    hint: "Zero desabilita. Uma consulta deve terminar antes do prazo da requisição.",
  },
  storage_max_file_size: {
    label: "Tamanho máximo por arquivo (bytes)",
    hint: "Limite para novos uploads; buckets podem usar um limite menor. Não remove arquivos existentes.",
  },
  storage_max_total_size: {
    label: "Cota total de arquivos (bytes)",
    hint: "O padrão não impõe uma cota global. Zero não deixa espaço para novos arquivos não vazios. Reduzir a cota não apaga arquivos existentes.",
  },
  storage_min_free_bytes: {
    label: "Reserva mínima de disco (bytes)",
    hint: "O armazenamento local recusa uploads que violem esta reserva. Não reserva espaço para outros serviços.",
  },
  storage_upload_timeout_secs: {
    label: "Prazo de upload (segundos)",
    hint: "Tempo máximo de um upload, limitado a um dia.",
  },
  storage_uploads_per_caller: {
    label: "Uploads simultâneos por cliente",
    hint: "Até 32 por cliente. Zero desabilita o limite individual; o limite global de 32 permanece.",
  },
} satisfies Record<ProjectSettingKey, { label: string; hint: string }>;

const ptBR = {
  authority:
    "Configurações do projeto aplicadas pelo operador autenticado do host. O login do administrador do projeto não concede esta autoridade.",
  impact:
    "Todas as alterações deste lote são aplicadas juntas, com um único reinício da aplicação selecionada. O painel do projeto perde suas sessões; PostgreSQL e outros projetos continuam em execução. Uma falha tenta restaurar somente a configuração, nunca os dados.",
  unsupported:
    "Este controlador ainda não oferece o catálogo de configurações. Use um controlador compatível; nenhum campo será aplicado por um fluxo alternativo.",
  notPrepared:
    "O plano não foi preparado. Confira a mensagem da operação e recarregue se a configuração tiver mudado.",
  automatic: "Padrão / automático",
  noOrigins: "Nenhuma origem externa",
  anyOrigin: "Qualquer origem",
  yes: "Sim",
  no: "Não",
  saved: "Salvo",
  proposed: "Proposto",
  source: "Origem do valor salvo",
  default: "Padrão",
  runtimeValue: "Em uso pelo processo",
  useDefault: "Usar comportamento padrão",
  pending:
    "O valor salvo difere do processo em execução. Revise a alteração ou recupere a operação pendente antes de continuar.",
  changed: "Campos alterados",
  review: "Validar lote e revisar impacto",
  reviewedChanges: "Alterações validadas pelo servidor",
  groups: {
    authentication: "Autenticação e sessões",
    email: "Emails transacionais e links",
    api: "API e desempenho",
    storage: "Limites globais de arquivos",
  },
  sources: { default: "Padrão do servidor", environment: "Arquivo de ambiente do projeto" },
  runtime: {
    effective:
      "Os valores em uso vêm de uma projeção segura do processo, capturada na inicialização e consultada apenas por conexão local. A aplicação é verificada novamente após aplicar ou reverter o lote.",
    unavailable:
      "Não foi possível consultar a aplicação ou ela não oferece este protocolo. Use versões compatíveis de servidor e controlador. Os valores salvos não serão apresentados como ativos e a edição fica bloqueada.",
    file_override:
      "O contêiner usa um arquivo de configuração adicional. Seus valores ativos não podem ser confirmados por este fluxo.",
    invalid: "O ambiente do contêiner não pôde ser interpretado. Nenhum valor ativo foi presumido.",
  },
  blocked: {
    file_override:
      "Este projeto usa NELCOTA_CONFIG. O operador precisa revisar a configuração por arquivo antes de habilitar alterações por este fluxo.",
    invalid_saved_configuration:
      "A configuração salva é inválida ou usa sintaxe ambígua. O operador precisa corrigi-la pelo procedimento de recuperação; ela não será sobrescrita.",
  },
  fields,
};
export default ptBR;
