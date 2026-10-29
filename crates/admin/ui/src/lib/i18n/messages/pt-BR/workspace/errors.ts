// Server error codes (admin API `code` field) → text in each language.
// Keys must match the codes in crates/admin/src; placeholders match `params`.
// Errors without a code (e.g. Postgres messages) are shown as the server sent them.
import common from "./common";

const ptBR = {
  network: "Sem resposta do servidor. Confira se ele está rodando e tente de novo.",
  // Set by the panel itself when the response is not a panel error (api.ts).
  server_unreachable:
    "O servidor não está respondendo (HTTP {status}). Ele pode estar reiniciando: tente de novo em instantes.",
  unexpected_response: "Resposta inesperada do servidor (HTTP {status}).",
  // Translated when shown (not when thrown), e.g. a session check answered before the texts loaded.
  invalid_response: common.invalidResponse,
  request_timeout: "A solicitação demorou demais. Atualize a página e tente novamente.",
  write_timeout:
    "Não foi possível confirmar o resultado da solicitação. Atualize os dados antes de tentar novamente.",
  sql_busy: "Todas as conexões do editor estão ocupadas. Aguarde uma consulta terminar.",
  export_busy: "Há exportações em andamento. Tente de novo após um download terminar.",
  internal: "Erro interno do servidor. Os detalhes estão no log do servidor.",
  unavailable: "Banco de dados indisponível. Confira se o Postgres está rodando e tente de novo.",
  invalid_range: "Período inválido: use 1h ou 24h.",
  webhook_invalid_url:
    "Use uma URL HTTPS pública, sem credenciais, parâmetros ou fragmento. No desenvolvimento, loopback exige configuração no servidor.",
  webhook_invalid_name: "O nome precisa ter de 1 a 80 caracteres, sem caracteres de controle.",
  webhook_invalid_attempts: "Escolha de 1 a 10 tentativas.",
  webhook_invalid_events: "Escolha pelo menos um evento: linha inserida, atualizada ou apagada.",
  webhook_invalid_table: "Escolha uma tabela comum do schema exposto que ainda exista.",
  webhook_table_immutable: "Crie outro webhook para acompanhar uma tabela diferente.",
  webhook_limit: "O projeto já tem 50 webhooks. Apague um antes de criar outro.",
  webhook_table_limit: "Esta tabela já tem 10 webhooks.",
  webhook_invalid_status: "Estado de entrega inválido.",
  webhook_not_found: "Webhook ou entrega não encontrado. O histórico concluído pode ter expirado.",
  webhook_paused: "Ative o webhook antes de reenviar.",
  webhook_delivery_active: "A entrega ou um reenvio já está na fila. Aguarde terminar.",
  webhook_payload_omitted:
    "Os dados passaram do limite e foram omitidos. Este evento não pode ser reenviado.",
  webhook_queue_full: "A fila atingiu o limite. Retome os envios ou limpe o histórico concluído.",

  // Session and access
  route_not_found: "Rota não encontrada.",
  session_expired: "Sessão expirada: entre de novo.",
  origin_not_allowed: "Origem não permitida.",
  too_many_attempts: "Muitas tentativas. Aguarde um minuto.",
  invalid_credentials: "E-mail ou senha inválidos.",
  sso_disabled: "Login único desligado: entre no painel de cada projeto.",
  project_not_found: "O projeto '{project}' não existe neste host.",
  sso_link_invalid: "Link de acesso inválido ou expirado: entre de novo.",

  // Tables and rows
  table_not_found: "A tabela '{table}' não existe no schema exposto.",
  invalid_filters: "Filtros inválidos: {detail}",
  invalid_query: "Consulta inválida: {detail}",
  invalid_page: "Número de página grande demais. Volte à primeira página.",
  unknown_or_generated_column: "Coluna desconhecida ou gerada: {column}.",
  invalid_json_value: "{column}: JSON inválido ({detail}).",
  no_primary_key: "Tabela sem chave primária: edição pelo painel indisponível (use o editor SQL).",
  missing_key_value: "Valor da chave '{column}' ausente.",
  no_rows_selected: "Nenhuma linha selecionada.",
  view_denied: "Sem acesso: {role} não tem permissão (GRANT) para ler esta tabela.",
  invalid_view_as: "Escolha ver como visitante ou como um usuário.",

  // Users
  invalid_id: "Id inválido.",
  user_not_found: "Usuário não encontrado.",
  user_already_exists: "Já existe um usuário com este e-mail.",
  invalid_email: "E-mail inválido.",
  password_too_short: "A senha precisa de pelo menos {min} caracteres.",
  password_too_long: "A senha pode ter no máximo {max} caracteres.",

  // Tokens and profile
  invalid_token_validity: "Validade entre 1 e {max} dias.",
  no_profile_photo: "Sem foto de perfil.",
  invalid_image_base64: "Imagem inválida (base64).",
  photo_too_large: "A foto deve ter até {max_kb} KB.",
  unsupported_image_type: "Use uma imagem PNG, JPEG ou WebP.",

  // Migrations
  invalid_migration_name: "Nome com letras minúsculas, números e _ (até 60), ex.: criar_pedidos.",
  no_pending_changes: "Nenhuma alteração do painel fora das migrações.",
  migration_not_from_panel: "Esta migração não foi gerada pelo painel.",

  // Structure (DDL) validation
  name_empty: "Nome vazio.",
  name_surrounding_spaces: "'{name}': sem espaços no começo ou no fim.",
  name_too_long: "'{name}': máximo de {max} bytes.",
  name_invalid_character: "Nome com caractere inválido.",
  expression_empty: "{kind}: expressão vazia.",
  type_unclosed_parenthesis: "Tipo '{type}': parêntese sem fechar.",
  unknown_type: "Tipo desconhecido: '{type}'.",
  invalid_type_modifier: "Tipo '{type}': modificador inválido.",
  identity_requires_integer: "Coluna '{column}': identity só em smallint, integer ou bigint.",
  identity_with_default: "Coluna '{column}': identity não aceita DEFAULT.",
  table_needs_columns: "A tabela precisa de pelo menos uma coluna.",
  duplicate_column: "Coluna '{column}' repetida.",
  no_changes: "Nenhuma alteração.",
  primary_key_on_create_only: "A chave primária é definida na criação da tabela.",
  column_already_exists: "A coluna '{column}' já existe.",
  column_not_found: "A coluna '{column}' não existe.",
  column_rejects_default: "A coluna '{column}' é identity/gerada: não aceita DEFAULT.",
  policy_insert_no_using:
    "Política de INSERT não usa USING: a linha ainda não existe (use WITH CHECK).",
  policy_check_not_allowed:
    "Política de {command} não usa WITH CHECK: nenhuma linha é gravada (use USING).",
  policy_insert_needs_check: "Política de INSERT precisa de WITH CHECK.",
  policy_needs_using: "A política precisa da expressão USING.",

  // Storage
  storage_disabled: "Armazenamento desligado: defina NELCOTA_STORAGE_BACKEND.",
  invalid_bucket_name:
    "Nome de bucket com letras minúsculas, números, - e _ (até 63). public, sign e list são reservados.",
  invalid_mime_type: "Tipo inválido: '{type}'. Use image/png ou image/*.",
  invalid_size_limit: "O limite precisa ser maior que zero.",
  bucket_exists: "Já existe um bucket '{bucket}'.",
  bucket_not_found: "Bucket não encontrado.",
  bucket_not_empty: "O bucket ainda tem arquivos: apague-os antes.",
  invalid_path: "Nome de arquivo inválido: sem barras duplas, . ou .. e caracteres de controle.",
  object_not_found: "Arquivo não encontrado.",
  object_exists: "Já existe um arquivo com este nome.",
  file_too_large: "O arquivo passa do limite deste bucket.",
  mime_type_not_allowed: "Este bucket não aceita esse tipo de arquivo.",
  storage_full: "Sem espaço: a cota de storage ou o disco do servidor está cheio.",
  upload_timeout: "O envio demorou demais.",
  upload_interrupted: "O envio foi interrompido.",
  upload_busy: "Muitos envios ao mesmo tempo. Tente de novo em instantes.",
  no_files_selected: "Nenhum arquivo selecionado.",
  too_many_files: "No máximo {max} arquivos por vez.",
};

export default ptBR;
