const ptBR = {
  title: "Prévia e teste do email",
  variables:
    "Mensagem: {{project_name}}, {{email}}, {{validity}} e exatamente um {{link}}. No assunto, apenas {{project_name}} e {{validity}}. Sem HTML ou expressões executáveis.",
  safety:
    "A prévia usa dados fictícios. O teste usa o SMTP já aplicado e envia apenas ao administrador configurado, no máximo uma vez por minuto. Nenhum token real é criado; testar não salva o rascunho.",
  kind: "Tipo de email",
  recovery: "Recuperação de senha",
  signup: "Confirmação de email",
  magiclink: "Link de acesso",
  preview: "Gerar prévia do rascunho",
  sendTest: "Enviar rascunho de teste",
  recipient: "Destinatário fixo do teste",
  unavailable:
    "Para enviar, aplique o SMTP e abra o painel do próprio projeto selecionado. A prévia não precisa de SMTP.",
  accepted:
    "O SMTP aceitou o teste. Isso não comprova entrega na caixa de entrada. Nenhum link de autenticação foi emitido e o rascunho não foi salvo.",
  result: "Prévia com dados fictícios",
};
export default ptBR;
