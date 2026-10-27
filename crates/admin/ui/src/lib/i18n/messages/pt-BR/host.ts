const ptBR = {
  docker_namespace_exists:
    'Já existem containers, volumes ou redes Docker reservados para esse nome. Inspecione-os por SSH antes de criar o projeto.',
  docker_unavailable:
    'Não foi possível consultar o Docker da VPS. Resolva o runtime antes de criar o projeto.',
  storageCleanupFailure:
    'O resultado foi confirmado na VPS, mas o navegador não conseguiu limpar o identificador local. Ele será consultado novamente ao recarregar.',
  lastStage: 'Última etapa registrada',
  preserveWrites:
    'A restauração já chegou à verificação. A recuperação verifica o estado atual e preserva gravações posteriores; não reaplica o backup.',
  operation_failed:
    'A execução falhou. Consulte o diagnóstico privado da VPS antes de recuperar.',
  interrupted: 'A execução foi interrompida.',
  worker_interrupted:
    'O worker foi interrompido; revise a última etapa antes de recuperar.',
  history_full:
    'O histórico atingiu o limite. Arquive apenas operações concluídas por SSH.',
  title: 'Projetos da VPS',
  subtitle:
    'Crie e acompanhe backends isolados com operações confirmadas e histórico persistente.',
  projects: 'Projetos',
  updates: 'Atualizações',
  create: 'Novo projeto',
  name: 'Nome do projeto',
  domain: 'Domínio da API',
  profile: 'Perfil do PostgreSQL',
  preview: 'Validar e revisar',
  review: 'Revise antes de confirmar',
  isolation: 'Este projeto terá banco, usuários, chaves e arquivos próprios.',
  ram: 'RAM da VPS',
  disk: 'Espaço livre',
  count: 'Projetos na VPS',
  version: 'Versão aprovada pelo operador',
  image: 'Imagem aprovada por digest',
  imagePending:
    'A assinatura e a origem da imagem serão verificadas antes de criar o projeto.',
  expires:
    'Esta revisão expira em cinco minutos e será validada novamente antes de executar.',
  blocked:
    'A operação está bloqueada. Corrija os requisitos e faça uma nova revisão.',
  acknowledge: 'Conferi o projeto, o domínio e o impacto desta operação.',
  rescue: 'Tenho acesso SSH e compreendo como recuperar a VPS.',
  typed: 'Digite exatamente a confirmação abaixo',
  password: 'Confirme a senha do operador',
  approve: 'Confirmar e executar',
  cancel: 'Cancelar revisão',
  busy: 'Processando…',
  submitted:
    'Pedido registrado na VPS. A operação continua mesmo se você fechar esta página.',
  uncertain:
    'Não foi possível confirmar a resposta. Consulte o histórico ou confirme novamente o mesmo pedido; a chave será reutilizada.',
  retry: 'Consultar estado novamente',
  pending: 'Pedido aguardando confirmação do resultado',
  history: 'Operações e recuperação',
  accepted: 'Pedido registrado',
  validating: 'Validando requisitos',
  provisioning: 'Preparando banco e arquivos',
  starting: 'Iniciando serviços',
  backing_up: 'Capturando backup consistente',
  applying: 'Aplicando a operação',
  verifying: 'Verificando o resultado',
  completed: 'Concluído e verificado',
  failed: 'Não concluído; nenhuma alteração destrutiva foi iniciada',
  needs_attention: 'Atenção do operador necessária',
  resume: 'Revisar recuperação',
  recovery:
    'A recuperação pode concluir a operação originalmente aprovada. Ela preserva os outros projetos. Inspecione o histórico e mantenha acesso SSH.',
  backup: 'Criar backup',
  restore: 'Restaurar backup',
  remove: 'Remover projeto',
  logs: 'Consultar logs',
  logService: 'Serviço',
  app: 'Backend',
  database: 'PostgreSQL',
  logPrivacy:
    'São exibidos somente metadados estruturados. Mensagens livres e SQL ficam nos logs privados da VPS para proteger dados e credenciais.',
  noLogs: 'Nenhum evento estruturado disponível.',
  noProjects: 'Nenhum projeto cadastrado.',
  noHistory: 'Nenhuma operação registrada.',
  backupFile: 'Backup selecionado',
  backupSaved: 'Backup preservado',
  selectBackup: 'Selecione um backup',
  destructive:
    'Esta operação substitui ou remove dados. Ela exige backup verificado e afeta apenas o projeto selecionado.',
  removeImpact:
    'O projeto será retirado do domínio; banco e volumes serão removidos. O backup final e a configuração ficarão no arquivo privado da VPS.',
  restoreImpact:
    'Os dados e arquivos serão substituídos pelo par selecionado. O estado atual será salvo antes; o projeto ficará em manutenção.',
  backupImpact:
    'Será criado um par consistente de banco e arquivos. Verifique também sua política de cópias fora da VPS.',
  offline:
    'Controlador indisponível. A operação aceita continua na VPS; ações ficam desabilitadas até reconectar.',
  unknown: 'Estado indisponível',
  healthy: 'Saudável',
  unhealthy: 'Não saudável',
  running: 'Em execução',
  exited: 'Parado',
  missing: 'Não encontrado',
  refresh: 'Atualizar estado',
  planExpired: 'A revisão expirou. Valide novamente antes de confirmar.',
  error:
    'A operação foi bloqueada ou a sessão precisa ser renovada. Consulte o estado e revise o pedido.',
  result: 'Resultado confirmado',
  storageFailure:
    'O navegador não conseguiu preservar o identificador do pedido. A execução está bloqueada para evitar duplicações após recarregar.',
  project_limit: 'Limite de projetos do host atingido.',
  project_exists: 'O nome ou a pasta já existem.',
  domain_exists: 'Domínio já usado por outro projeto ou pelo controlador.',
  domain_forbidden: 'Domínio fora do escopo aprovado na VPS.',
  dns_mismatch:
    'O DNS não aponta exclusivamente para os endereços aprovados da VPS.',
  dns_unavailable: 'Não foi possível resolver o DNS.',
  insufficient_memory:
    'O perfil não cabe na divisão estimada de RAM. Escolha outro perfil ou amplie a VPS.',
  insufficient_disk: 'Espaço livre abaixo da reserva exigida.',
  host_busy: 'Outra operação precisa terminar ou ser recuperada.',
  docker_required: 'A criação de vários projetos exige o runtime Docker.',
  shared_panel_required:
    'A criação pelo painel exige o login compartilhado dos painéis de projeto.',
  project_layout_changed:
    'A identidade, configuração, armazenamento ou PITR exige revisão por SSH.',
  backup_unavailable:
    'O par de backup selecionado não está disponível ou não é seguro.',
  metadata: 'Metadados do evento',
  copy: 'Copiar',
  copied: 'Copiado',
  progress: 'Etapas da operação',
  readOnly:
    'A criação e as operações do host precisam ser autorizadas por SSH no cadastro do operador.',
  successCreate:
    'Projeto criado. Abra o painel para criar tabelas e políticas de acesso.',
  openPanel: 'Abrir painel do projeto',
  max: 'Limite aprovado',
  estimated:
    'Os perfis são estimativas de configuração, não garantias de capacidade.',
  remaining: 'Validade da revisão',
  seconds: 'segundos',
  select: 'Selecionar projeto'
}

export default ptBR
