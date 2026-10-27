// Sign-in page: how the app's users get in, read from the server's settings.
import type { Messages } from '../../index.svelte'
import type ptBR from '../pt-BR/signIn'

const en: Messages<typeof ptBR> = {
  examples: 'View sign-in examples',
  title: 'User sign-in',
  description: 'How people get into your app.',
  fromEnv: "Read from the server's .env; changes need a restart.",
  on: 'On',
  off: 'Off',
  summary: { one: '{on} of {count} way to sign in is on', other: '{on} of {count} ways to sign in are on' },
  howTo: 'How to turn on',
  howToOff: 'How to turn off',
  envHint: "Add to the project's .env, fill in the values and restart (nelcota up).",
  envHintOff: "Change it in the project's .env and restart (nelcota up).",
  copyEnv: 'Copy variables',
  options: {
    password: {
      title: 'Sign-up with email and password',
      text: 'Anyone can create an account from the app.',
      textOn: 'Anyone can create an account from the app. Turn it off so only the panel creates users.',
      textOff: 'Only the panel creates users. Turn it on so anyone can create an account from the app.',
    },
    confirmation: { title: 'Email confirmation', text: 'An account can only sign in after clicking the link sent by email.' },
    recovery: { title: 'Password recovery', text: 'People get a link by email to choose a new password.' },
    magicLink: { title: 'Magic link', text: 'Sign in without a password, through a link sent by email.' },
    google: { title: 'Google', text: 'Sign in with a Google account.' },
    github: { title: 'GitHub', text: 'Sign in with a GitHub account.' },
  },
  providers: {
    title: 'Google and GitHub',
    callback: 'Callback address to register with Google or GitHub',
    copyCallback: 'Copy callback address',
    pages: 'App pages the sign-in may return to',
    noPages: 'No page registered (NELCOTA_OAUTH_REDIRECT_URLS).',
  },
  session: {
    title: 'Session',
    access: { label: 'Access lasts', unit: { one: 'minute', other: 'minutes' }, hint: 'The SDK refreshes it before it runs out.' },
    refresh: { label: 'Idle session', unit: { one: 'day', other: 'days' }, hint: 'After that long without using the app, people sign in again.' },
    rateLimit: { label: 'Sign-in attempts', unit: { one: 'per minute', other: 'per minute' }, hint: 'Per IP address; the rest are refused.' },
  },
}

export default en
