// Sign-in page: how the app's users get in, read from the server's settings.
const ptBR = {
  examples: "Ver exemplos de login",
  title: "Login dos usuários",
  description: "Como as pessoas entram no seu app.",
  fromEnv: "Vem do .env do servidor; mudanças pedem reinício.",
  on: "Ligado",
  off: "Desligado",
  summary: {
    one: "{on} de {count} forma de entrar ligada",
    other: "{on} de {count} formas de entrar ligadas",
  },
  howTo: "Como ligar",
  howToOff: "Como desligar",
  envHint: "Adicione ao .env do projeto, preencha os valores e reinicie (nelcota up).",
  envHintOff: "Troque no .env do projeto e reinicie (nelcota up).",
  copyEnv: "Copiar variáveis",
  options: {
    password: {
      title: "Cadastro com e-mail e senha",
      text: "Qualquer pessoa cria uma conta pelo app.",
      textOn:
        "Qualquer pessoa cria uma conta pelo app. Desligue para que só o painel crie usuários.",
      textOff: "Só o painel cria usuários. Ligue para que qualquer pessoa crie uma conta pelo app.",
    },
    confirmation: {
      title: "Confirmação de e-mail",
      text: "A conta só entra depois de clicar no link enviado por e-mail.",
    },
    recovery: {
      title: "Recuperação de senha",
      text: "A pessoa recebe um link por e-mail para escolher uma senha nova.",
    },
    magicLink: { title: "Link mágico", text: "Entrar sem senha, por um link enviado por e-mail." },
    google: { title: "Google", text: "Entrar com a conta Google." },
    github: { title: "GitHub", text: "Entrar com a conta GitHub." },
  },
  providers: {
    title: "Google e GitHub",
    callback: "Endereço de retorno para cadastrar no Google ou no GitHub",
    copyCallback: "Copiar endereço de retorno",
    pages: "Páginas do app para onde o login pode voltar",
    noPages: "Nenhuma página cadastrada (NELCOTA_OAUTH_REDIRECT_URLS).",
  },
  session: {
    title: "Sessão",
    access: {
      label: "Duração do acesso",
      unit: { one: "minuto", other: "minutos" },
      hint: "O SDK renova sozinho antes de acabar.",
    },
    refresh: {
      label: "Sessão parada",
      unit: { one: "dia", other: "dias" },
      hint: "Depois disso sem usar o app, é preciso entrar de novo.",
    },
    rateLimit: {
      label: "Tentativas de login",
      unit: { one: "por minuto", other: "por minuto" },
      hint: "Por endereço IP; o excesso é recusado.",
    },
  },
};

export default ptBR;
