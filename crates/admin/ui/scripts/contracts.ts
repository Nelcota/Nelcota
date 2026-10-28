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
  'WebhookEndpoints', 'WebhookEndpoint', 'WebhookSecret', 'WebhookDeliveries', 'WebhookDetail', 'WebhookReplay', 'WebhookCleared', 'AvatarEditor',
  // Controller responses (nelcota-deployment), schema only.
  'HostAlertStatus', 'HostAlertSettings', 'HostDiagnostics', 'HostConfigurationView', 'HostStatus', 'HostPlan', 'HostJob', 'HostOperation',
  'HostLogEntry', 'UpdateStatus', 'UpdatePlan', 'UpdateJob']
for (const name of names) {
  const schema = schemas[name]
  if (typeof schema !== 'object' || schema === null) throw new Error(`schemas.json has no ${name} schema object: export it from the export_contracts example or remove it from names`)
  ajv.addSchema(schema, name)
  refs[name] = name
}
// Some keywords (maxLength counts code points) call Ajv runtime helpers, which
// standalone code reaches through `require`. The browser loads an ES module, so
// copy each helper's function from its file (pinned by the lockfile, so the
// output does not depend on the Bun or Node version).
const RUNTIME_HELPER = /require\("ajv\/dist\/runtime\/([a-z0-9]+)"\)\.default/g
const TOP_LEVEL_FUNCTION = /^function [A-Za-z0-9_]+\([\s\S]*?^\}$/m
async function runtimeHelper(name: string): Promise<string> {
  const file = new URL(`../node_modules/ajv/dist/runtime/${name}.js`, import.meta.url)
  const source = TOP_LEVEL_FUNCTION.exec(await readFile(file, 'utf8'))?.[0]
  // A self-contained function only: anything else would need its own module scope.
  if (source === undefined || source.includes('require(')) throw new Error(`Ajv runtime helper ${name} cannot be inlined from ${file.pathname}`)
  return `const ajv_runtime_${name} = ${source};`
}
// Compile at build time: the browser never uses eval (the panel has a strict CSP).
const compiled = standalone(ajv, refs)
const helpers = [...new Set([...compiled.matchAll(RUNTIME_HELPER)].map(match => {
  const name = match[1]
  if (name === undefined) throw new Error(`Ajv runtime helper without a name: ${match[0]}`)
  return name
}))].sort()
const prelude = (await Promise.all(helpers.map(runtimeHelper))).join('\n')
const STRICT = '"use strict";'
const body = compiled.replace(RUNTIME_HELPER, (_match, name: string) => `ajv_runtime_${name}`)
const code = body.startsWith(STRICT) ? `${STRICT}\n${prelude}\n${body.slice(STRICT.length)}` : `${prelude}\n${body}`
if (code.includes('require(')) throw new Error('validators.js would still require a module; inline it or avoid the schema keyword that needs it')
await writeFile(new URL('../src/lib/generated/validators.js', import.meta.url), '// @ts-nocheck\n// Generated. Do not edit.\n' + code)
await writeFile(new URL('../src/lib/generated/validators.d.ts', import.meta.url), '// Generated. Do not edit.\n' + names.map(name => `export function ${name}(value: unknown): boolean;\n`).join(''))
