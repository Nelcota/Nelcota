import { readFile, writeFile } from 'node:fs/promises'
import { Ajv2020 } from 'ajv/dist/2020.js'
import standaloneModule from 'ajv/dist/standalone/index.js'
const schemas: Record<string, unknown> = JSON.parse(await readFile(new URL('../src/lib/generated/schemas.json', import.meta.url), 'utf8'))
const standalone = standaloneModule.default
const ajv = new Ajv2020({ code: { source: true, esm: true }, strict: false, validateFormats: false })
const refs: Record<string, string> = {}
const names = ['Overview', 'TablesResponse', 'SchemaResponse', 'UsersResponse', 'PoliciesData', 'ProjectsData',
  'ProjectsStatusData', 'MigrationsData', 'StorageOverview', 'TypesResponse', 'Structure', 'TableData', 'StorageListing',
  'SqlResponse', 'ExportedMigration', 'DdlResult', 'StorageAccess', 'DeniedRequests', 'SignIn', 'MetricsResponse',
  'WebhookEndpoints', 'WebhookEndpoint', 'WebhookSecret', 'WebhookDeliveries', 'WebhookDetail', 'WebhookReplay', 'WebhookCleared']
for (const name of names) {
  const schema = schemas[name]
  if (typeof schema !== 'object' || schema === null) throw new Error(`schemas.json has no ${name} schema object: export it from the export_contracts example or remove it from names`)
  ajv.addSchema(schema, name)
  refs[name] = name
}
// Compile at build time: the browser never uses eval (the panel has a strict CSP).
await writeFile(new URL('../src/lib/generated/validators.js', import.meta.url), '// @ts-nocheck\n// Generated. Do not edit.\n' + standalone(ajv, refs))
await writeFile(new URL('../src/lib/generated/validators.d.ts', import.meta.url), '// Generated. Do not edit.\n' + names.map(name => `export function ${name}(value: unknown): boolean;\n`).join(''))
