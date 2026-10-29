// The generated Ajv validators are a chunk of their own, fetched on the first
// response that needs one, so the login screen does not download them.
import type * as ValidatorModule from "$lib/generated/validators.js";
type Validators = typeof ValidatorModule;
type ContractName = keyof Validators;
type Validator = (value: unknown) => boolean;

const loadValidators = (): Promise<Validators> => import("$lib/generated/validators.js");

/**
 * Starts downloading the validators once a session is known, so the first
 * page's data does not wait for them after it arrives.
 */
export function preloadResponseContracts() {
  loadValidators().catch((error: unknown) => {
    // The first validated response repeats the import and reports the failure.
    console.warn("Preloading the response validators failed", error);
  });
}

/**
 * Select the wire contract centrally, independent of a caller's generic type.
 * Resolves to undefined only for responses without a contract; a failed
 * download of the validators rejects instead of skipping validation.
 */
export async function responseContract(
  method: string,
  path: string,
): Promise<Validator | undefined> {
  const name = contractName(method, path);
  if (name === undefined) return undefined;
  const validators = await loadValidators();
  return validators[name];
}

const READ_CONTRACTS: Record<string, ContractName> = {
  "/tokens/deploy": "DeployTokens",
  "/overview": "Overview",
  "/tables": "TablesResponse",
  "/schema": "SchemaResponse",
  "/users": "UsersResponse",
  "/policies": "PoliciesData",
  "/projects": "ProjectsData",
  "/projects/status": "ProjectsStatusData",
  "/migrations": "MigrationsData",
  "/storage": "StorageOverview",
  "/types": "TypesResponse",
  "/sign-in": "SignIn",
  "/denied": "DeniedRequests",
  "/metrics": "MetricsResponse",
  "/webhooks": "WebhookEndpoints",
  "/webhooks/deliveries": "WebhookDeliveries",
  "/profile/avatar/editor": "AvatarEditor",
};

interface RouteContract {
  methods: readonly string[];
  pattern: RegExp;
  name: ContractName;
}
const ROUTE_CONTRACTS: readonly RouteContract[] = [
  { methods: ["GET"], pattern: /^\/tables\/[^/]+\/structure$/, name: "Structure" },
  { methods: ["GET"], pattern: /^\/tables\/[^/]+$/, name: "TableData" },
  { methods: ["GET"], pattern: /^\/storage\/buckets\/[^/]+\/objects$/, name: "StorageListing" },
  { methods: ["GET"], pattern: /^\/storage\/buckets\/[^/]+\/access$/, name: "StorageAccess" },
  { methods: ["GET"], pattern: /^\/webhooks\/deliveries\/[^/]+$/, name: "WebhookDetail" },
  { methods: ["POST"], pattern: /^\/tokens\/deploy$/, name: "DeployToken" },
  {
    methods: ["POST"],
    pattern: /^(?:\/webhooks|\/webhooks\/[^/]+\/rotate)$/,
    name: "WebhookSecret",
  },
  { methods: ["PUT"], pattern: /^\/webhooks\/[^/]+$/, name: "WebhookEndpoint" },
  { methods: ["POST"], pattern: /^\/webhooks\/deliveries\/[^/]+\/replay$/, name: "WebhookReplay" },
  { methods: ["DELETE"], pattern: /^\/webhooks\/deliveries$/, name: "WebhookCleared" },
  { methods: ["POST"], pattern: /^\/sql$/, name: "SqlResponse" },
  { methods: ["POST"], pattern: /^\/migrations$/, name: "ExportedMigration" },
  { methods: ["POST"], pattern: /^\/migrations\/apply$/, name: "MigrationApplication" },
  {
    methods: ["POST", "PATCH", "PUT", "DELETE"],
    pattern:
      /^(?:\/tables|\/tables\/[^/]+(?:\/policies(?:\/[^/]+)?)?|\/storage\/buckets\/[^/]+\/access(?:\/[^/]+)?)$/,
    name: "DdlResult",
  },
];

function contractName(method: string, path: string): ContractName | undefined {
  const [route = ""] = path.split("?");
  if (method === "GET" && Object.hasOwn(READ_CONTRACTS, route)) return READ_CONTRACTS[route];
  return ROUTE_CONTRACTS.find(
    (contract) => contract.methods.includes(method) && contract.pattern.test(route),
  )?.name;
}
