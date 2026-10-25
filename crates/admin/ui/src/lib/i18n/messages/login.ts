// Login screen.
import type { Messages } from '../index.svelte'

const ptBR = {
  title: 'Entrar no Nelcota',
  project: 'Projeto',
  subtitle: 'Entre com a conta de administrador deste servidor.',
  email: 'E-mail',
  emailPlaceholder: 'voce@empresa.com',
  password: 'Senha',
  signIn: 'Entrar',
  signingIn: 'Entrando…',
  capsLock: 'Caps Lock ativado.',
  emailRequired: 'Digite seu e-mail.',
  passwordRequired: 'Digite sua senha.',
  help: 'Precisa de ajuda?',
  restricted: 'Acesso exclusivo para administradores.',
  sessionExpired: 'Sua sessão expirou. Entre novamente para continuar.',
}

const en: Messages<typeof ptBR> = {
  title: 'Sign in to Nelcota',
  project: 'Project',
  subtitle: "Sign in with this server's administrator account.",
  email: 'Email address',
  emailPlaceholder: 'you@company.com',
  password: 'Password',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  capsLock: 'Caps Lock is on.',
  emailRequired: 'Enter your email address.',
  passwordRequired: 'Enter your password.',
  help: 'Need help?',
  restricted: 'Administrator access only.',
  sessionExpired: 'Your session expired. Sign in again to continue.',
}

export default { 'pt-BR': ptBR, en }
