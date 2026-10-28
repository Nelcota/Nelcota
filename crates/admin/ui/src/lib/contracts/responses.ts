// The generated Ajv validators are a chunk of their own, fetched on the first
// response that needs one, so the login screen does not download them.
type Validators = typeof import('$lib/generated/validators.js')
type ContractName = keyof Validators
type Validator = (value: unknown) => boolean

const loadValidators = (): Promise<Validators> => import('$lib/generated/validators.js')

/**
 * Starts downloading the validators once a session is known, so the first
 * page's data does not wait for them after it arrives.
 */
export function preloadResponseContracts() {
  loadValidators().catch((error: unknown) => {
    // The first validated response repeats the import and reports the failure.
    console.warn('Preloading the response validators failed', error)
  })
}

/**
 * Select the wire contract centrally, independent of a caller's generic type.
 * Resolves to undefined only for responses without a contract; a failed
 * download of the validators rejects instead of skipping validation.
 */
export async function responseContract(method: string, path: string): Promise<Validator | undefined> {
  const name = contractName(method, path)
  if (name === undefined) return undefined
  const validators = await loadValidators()
  return validators[name]
}

function contractName(method: string, path: string): ContractName | undefined {
  const route = path.split('?')[0]
  if (method === 'GET') {
    const exact: Record<string, ContractName> = {
      '/tokens/deploy': 'DeployTokens', '/overview': 'Overview', '/tables': 'TablesResponse', '/schema': 'SchemaResponse', '/users': 'UsersResponse',
      '/policies': 'PoliciesData', '/projects': 'ProjectsData', '/projects/status': 'ProjectsStatusData', '/migrations': 'MigrationsData',
      '/storage': 'StorageOverview', '/types': 'TypesResponse', '/sign-in': 'SignIn', '/denied': 'DeniedRequests', '/metrics': 'MetricsResponse',
      '/webhooks': 'WebhookEndpoints', '/webhooks/deliveries': 'WebhookDeliveries',
    }
    if (Object.hasOwn(exact, route)) return exact[route]
    if (/^\/tables\/[^/]+\/structure$/.test(route)) return 'Structure'
    if (/^\/tables\/[^/]+$/.test(route)) return 'TableData'
    if (/^\/storage\/buckets\/[^/]+\/objects$/.test(route)) return 'StorageListing'
    if (/^\/storage\/buckets\/[^/]+\/access$/.test(route)) return 'StorageAccess'
    if (/^\/webhooks\/deliveries\/[^/]+$/.test(route)) return 'WebhookDetail'
  }
  if (method === 'POST' && route === '/tokens/deploy') return 'DeployToken'
  if (method === 'POST' && (route === '/webhooks' || /^\/webhooks\/[^/]+\/rotate$/.test(route))) return 'WebhookSecret'
  if (method === 'PUT' && /^\/webhooks\/[^/]+$/.test(route)) return 'WebhookEndpoint'
  if (method === 'POST' && /^\/webhooks\/deliveries\/[^/]+\/replay$/.test(route)) return 'WebhookReplay'
  if (method === 'DELETE' && route === '/webhooks/deliveries') return 'WebhookCleared'
  if (method === 'POST' && route === '/sql') return 'SqlResponse'
  if (method === 'POST' && route === '/migrations') return 'ExportedMigration'
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) &&
      (route === '/tables' || /^\/tables\/[^/]+(?:\/policies(?:\/[^/]+)?)?$/.test(route) ||
       /^\/storage\/buckets\/[^/]+\/access(?:\/[^/]+)?$/.test(route))) return 'DdlResult'
  return undefined
}
