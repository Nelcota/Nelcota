// The English catalog, typed against the Portuguese one: a missing or extra
// key is a type error. Loaded on demand (see ../../index.svelte.ts).
import type { Messages } from '../../index.svelte'
import type ptBR from '../pt-BR'
import common from './common'
import shell from './shell'
import login from './login'
import overview from './overview'
import users from './users'
import storage from './storage'
import projects from './projects'
import profile from './profile'
import policies from './policies'
import connect from './connect'
import signIn from './signIn'
import migrations from './migrations'
import tables from './tables'
import sql from './sql'
import palette from './palette'
import errors from './errors'
import guided from './guided'
import guides from './guides'
import webhooks from './webhooks'
import updates from './updates'
import host from './host'
import server from './server'
import alerts from './alerts'

const en: Messages<typeof ptBR> = {
  common,
  shell,
  login,
  overview,
  users,
  storage,
  projects,
  profile,
  policies,
  connect,
  signIn,
  migrations,
  tables,
  sql,
  palette,
  errors,
  guided,
  guides,
  webhooks,
  updates,
  host,
  server,
  alerts,
}

export default en
