import * as validators from '$lib/generated/validators.js'

type Validator = (value: unknown) => boolean
const validate = validators as Record<string, Validator>

/** Select the wire contract centrally, independent of a caller's generic type. */
export function responseContract(method: string, path: string): Validator | undefined {
  const route = path.split('?')[0]
  if (method === 'GET') {
    const exact: Record<string, string> = {
      '/overview': 'Overview', '/tables': 'TablesResponse', '/schema': 'SchemaResponse', '/users': 'UsersResponse',
      '/policies': 'PoliciesData', '/projects': 'ProjectsData', '/projects/status': 'ProjectsStatusData', '/migrations': 'MigrationsData',
      '/storage': 'StorageOverview', '/types': 'TypesResponse', '/sign-in': 'SignIn', '/denied': 'DeniedRequests', '/metrics': 'MetricsResponse',
      '/webhooks': 'WebhookEndpoints', '/webhooks/deliveries': 'WebhookDeliveries',
    }
    if (exact[route]) return validate[exact[route]]
    if (/^\/tables\/[^/]+\/structure$/.test(route)) return validate.Structure
    if (/^\/tables\/[^/]+$/.test(route)) return validate.TableData
    if (/^\/storage\/buckets\/[^/]+\/objects$/.test(route)) return validate.StorageListing
    if (/^\/storage\/buckets\/[^/]+\/access$/.test(route)) return validate.StorageAccess
    if (/^\/webhooks\/deliveries\/[^/]+$/.test(route)) return validate.WebhookDetail
  }
  if (method === 'POST' && (route === '/webhooks' || /^\/webhooks\/[^/]+\/rotate$/.test(route))) return validate.WebhookSecret
  if (method === 'PUT' && /^\/webhooks\/[^/]+$/.test(route)) return validate.WebhookEndpoint
  if (method === 'POST' && /^\/webhooks\/deliveries\/[^/]+\/replay$/.test(route)) return validate.WebhookReplay
  if (method === 'DELETE' && route === '/webhooks/deliveries') return validate.WebhookCleared
  if (method === 'POST' && route === '/sql') return validate.SqlResponse
  if (method === 'POST' && route === '/migrations') return validate.ExportedMigration
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) &&
      (route === '/tables' || /^\/tables\/[^/]+(?:\/policies(?:\/[^/]+)?)?$/.test(route) ||
       /^\/storage\/buckets\/[^/]+\/access(?:\/[^/]+)?$/.test(route))) return validate.DdlResult
  return undefined
}
