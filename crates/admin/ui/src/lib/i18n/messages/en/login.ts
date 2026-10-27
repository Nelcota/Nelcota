// Login screen.
import type { Messages } from '../../index.svelte'
import type ptBR from '../pt-BR/login'

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

export default en
