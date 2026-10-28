// App shell: sidebar, topbar, account menu, page names and tab titles.
import type { Messages } from '../../index.svelte'
import type ptBR from '../pt-BR/shell'

const en: Messages<typeof ptBR> = {
  pages: {
    overview: 'Overview',
    tables: 'Tables',
    structure: 'Structure',
    sql: 'SQL editor',
    migrations: 'Migrations',
    users: 'Users',
    storage: 'Storage',
    policies: 'Policies',
    connect: 'Connect',
    guides: 'Guides and references',
    projects: 'Projects',
    updates: 'Updates',
    database: 'Database',
    notFound: 'Page not found',
    signIn: 'Sign in',
    userSignIn: 'User sign-in',
    webhooks: 'Events and webhooks',
  },
  nav: {
    main: 'Main navigation',
    userList: 'User list',
    workspace: 'Project',
    breadcrumb: 'Current location',
    shortcuts: 'Workspace shortcuts',
    menu: 'Menu',
    short: { policies: 'Access', webhooks: 'Webhooks', webhookConfig: 'Settings', deliveries: 'Deliveries', signIn: 'Sign-in methods', attention: 'Attention' },
  },
  topbar: {
    searchLabel: 'Search',
  },
  account: {
    label: 'Account',
    role: 'Administrator',
    signedInAs: 'Signed in as',
    addPhoto: 'Add photo…',
    changePhoto: 'Change photo…',
    lightTheme: 'Light theme',
    darkTheme: 'Dark theme',
    language: 'Language',
    signOut: 'Sign out',
  },
  languages: {
    'pt-BR': 'Português',
    en: 'English',
  },
  projects: {
    switch: 'Switch project',
    loading: 'Loading projects…',
    unavailable: 'Project list unavailable. Open Projects to try again.',
    heading: 'Projects',
    separateLogin: 'Projects (each asks for its own login)',
    all: 'All projects',
    environment: { local: 'Local environment', remote: 'On {host}' },
    server: { online: 'Server is up', offline: 'Server is not answering', checking: 'Checking the server' },
    databaseTabs: 'Database sections',
  },
  app: {
    loading: 'Loading panel…',
    skipToContent: 'Skip to content',
    offlineTitle: 'Could not reach the server',
    boot: {
      steps: 'Loading steps',
      session: 'Connecting to the server',
      sessionDetail: 'Checking your session securely.',
      panel: 'Opening the panel',
      panelDetail: 'Getting the project tools ready.',
      done: 'done',
      current: 'in progress',
      pending: 'up next',
      slow: 'This is taking longer than usual. The server may be busy or the connection slow.',
    },
  },
}

export default en
