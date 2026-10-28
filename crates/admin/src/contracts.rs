//! Wire contracts are defined here, then exported to TypeScript and JSON Schema.
//! Keep nullable values explicit: SQL NULL and a missing field are different.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

macro_rules! dto {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Serialize, Deserialize, JsonSchema, TS)]
        pub struct $name { $(pub $field: $ty),* }
    };
}
#[derive(Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum RlsState {
    Ok,
    Warn,
    Danger,
    None,
    View,
}
dto!(Rls {
    state: RlsState,
    label: String,
    enabled: bool,
    forced: bool,
    policies: usize
});
dto!(TableSummary {
    name: String,
    kind: String,
    has_pk: bool,
    rls: Rls
});
dto!(TablesResponse { schema: String, tables: Vec<TableSummary> });
dto!(Counts {
    tables: usize,
    users: i64,
    signed_in_users: i64,
    policies: usize,
    functions: usize
});
dto!(Grants { anon: Vec<String>, authenticated: Vec<String> });
dto!(OverviewTable { name: String, kind: String, comment: Option<String>, rows: Option<i64>, rows_exact: bool, rls: Rls, grants: Grants });
dto!(Overview { schema: String, counts: Counts, exposed_without_rls: Vec<String>, tables: Vec<OverviewTable> });
dto!(ColumnReference {
    table: String,
    column: String
});
dto!(Column { name: String, r#type: String, full_type: String, category: String, nullable: bool, has_default: bool, generated: bool, enum_values: Vec<String>, is_pk: bool, comment: Option<String>, references: Option<ColumnReference> });
pub type RowData = BTreeMap<String, Option<String>>;
dto!(TableInfo { name: String, kind: String, comment: Option<String>, primary_key: Vec<String>, editable: bool, insertable: bool, exposed_without_rls: bool, rls: Rls, columns: Vec<Column> });
dto!(TableData { table: TableInfo, rows: Vec<RowData>, page: i64, size: i64, has_next: bool, total: Option<i64>, total_exact: bool });
dto!(User { id: String, email: String, created_at: String, last_sign_in_at: Option<String>, email_confirmed_at: Option<String>, sessions: i64, has_password: bool, providers: Vec<String> });
dto!(UsersResponse { users: Vec<User>, total: i64, page: i64, has_next: bool });
dto!(Policy { name: String, permissive: bool, roles: Vec<String>, command: String, using: Option<String>, check: Option<String> });
dto!(PolicyTable { name: String, rls: Rls, exposed_without_rls: bool, policies: Vec<Policy> });
dto!(PoliciesData { schema: String, exposed_without_rls: Vec<String>, tables: Vec<PolicyTable>, anon_functions: Vec<String> });
dto!(ProjectLink { name: String, url: Option<String>, current: bool });
dto!(ProjectsData { current: String, sso: bool, projects: Vec<ProjectLink> });
dto!(ProjectStatus { name: String, url: Option<String>, current: bool, healthy: bool, version: Option<String>, latency_ms: Option<u64> });
dto!(ProjectsStatusData { current: String, projects: Vec<ProjectStatus> });
dto!(Migration { version: i64, name: String, applied_on: Option<String>, in_folder: Option<bool>, from_panel: bool });
dto!(PendingChange { id: i64, applied_at: String, summary: String, statements: Vec<String>, kind: Option<String>, target: Option<String> });
dto!(DeployToken {
    id: i64,
    token: String,
    expires_at: String
});
dto!(DeployTokenInfo { id: i64, name: String, issued_by: String, issued_at: String, expires_at: String, revoked_at: Option<String> });
dto!(DeployTokens { tokens: Vec<DeployTokenInfo> });
dto!(MigrationsData { migrations: Vec<Migration>, pending: Vec<PendingChange>, next_version: i64, folder: Option<String> });
dto!(ExportedMigration {
    version: i64,
    filename: String,
    sql: String,
    message: String
});
dto!(Bucket { id: String, public: bool, file_size_limit: Option<i64>, allowed_mime_types: Option<Vec<String>>, created_at: String, files: i64, bytes: i64 });
#[derive(Serialize, Deserialize, JsonSchema, TS)]
pub struct StorageEnabled {
    #[ts(type = "true")]
    #[schemars(transform = enabled)]
    pub enabled: bool,
    pub backend: StorageBackend,
    pub max_file_size: u64,
    pub max_total_size: Option<u64>,
    pub public_url: Option<String>,
    pub buckets: Vec<Bucket>,
}
#[derive(Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum StorageBackend {
    Disk,
    S3,
}
#[derive(Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum StorageOverview {
    Enabled(StorageEnabled),
    Disabled {
        #[ts(type = "false")]
        #[schemars(transform = disabled)]
        enabled: bool,
    },
}
fn enabled(schema: &mut schemars::Schema) {
    schema.insert("const".into(), serde_json::json!(true));
}
fn disabled(schema: &mut schemars::Schema) {
    schema.insert("const".into(), serde_json::json!(false));
}
dto!(StoredFile { id: String, name: String, size: u64, mime_type: String, owner: Option<String>, updated_at: String });
dto!(StorageListing { folders: Vec<String>, objects: Vec<StoredFile>, has_next: bool });
dto!(SchemaResponse { schema: String, tables: BTreeMap<String, Vec<String>> });
dto!(StoragePolicy { name: String, command: String, roles: Vec<String>, using: Option<String>, check: Option<String>, all_buckets: bool });
dto!(StorageAccess { bucket: String, public: bool, policies: Vec<StoragePolicy> });
dto!(DeniedRequest { at: String, method: String, path: String, status: u16, code: String, message: String, role: String, user_id: Option<String>, email: Option<String> });
dto!(DeniedRequests { capacity: usize, requests: Vec<DeniedRequest> });
dto!(MetricsPoint { at: String, requests: u32, refused: u32, errors: u32, p95_ms: Option<u32> });
dto!(MetricsTotals { requests: u32, refused: u32, errors: u32, rest: u32, auth: u32, storage: u32, p95_ms: Option<u32> });
dto!(MetricsResponse { range: String, step_secs: u64, since: String, points: Vec<MetricsPoint>, totals: MetricsTotals });
dto!(SignInProviders {
    google: bool,
    github: bool
});
dto!(SignIn { signup_enabled: bool, email: bool, email_confirmation: bool, password_recovery: bool, magic_link: bool, providers: SignInProviders, redirect_urls: Vec<String>, callback_url: Option<String>, access_ttl_secs: u64, refresh_ttl_days: u32, rate_limit_per_minute: u32 });
dto!(TypesResponse { base: Vec<String>, enums: Vec<String> });
#[derive(Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AvatarCrop {
    #[schemars(range(min = 0, max = 1))]
    pub x: f64,
    #[schemars(range(min = 0, max = 1))]
    pub y: f64,
    #[schemars(range(min = 1, max = 4))]
    pub zoom: f64,
    #[schemars(range(min = 0, max = 270))]
    pub rotation: u16,
}
dto!(AvatarEditor {
    source: String,
    crop: AvatarCrop
});
dto!(WebhookEndpoint { id: String, name: String, schema: String, table: String, table_available: bool, url: String, events: Vec<String>, enabled: bool, max_attempts: i32, created_at: String });
dto!(WebhookEndpoints { endpoints: Vec<WebhookEndpoint>, tables: Vec<String>, allow_loopback: bool, outstanding: i64, retained: i64 });
dto!(WebhookSecret {
    endpoint: WebhookEndpoint,
    secret: String
});
dto!(WebhookDelivery { id: String, endpoint_id: String, endpoint_name: String, endpoint_enabled: bool, event_id: String, replay_of: Option<String>, schema: String, table: String, event: String, url: String, status: String, attempts: i32, max_attempts: i32, created_at: String, next_attempt_at: Option<String>, finished_at: Option<String>, last_status: Option<i32>, last_error: Option<String> });
dto!(WebhookDeliveries { deliveries: Vec<WebhookDelivery>, next_cursor: Option<String> });
dto!(WebhookAttempt { number: i32, started_at: String, finished_at: Option<String>, status_code: Option<i32>, duration_ms: Option<i64>, error: Option<String> });
dto!(WebhookDetail { delivery: WebhookDelivery, payload: String, attempts: Vec<WebhookAttempt> });
dto!(WebhookReplay { id: String });
dto!(WebhookCleared { deleted: u64 });

#[derive(Default, Serialize, Deserialize, JsonSchema, TS)]
pub struct DdlResult {
    pub sql: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
    pub applied: bool,
    pub catalog_pending: bool,
}
#[derive(Default, Serialize, Deserialize, JsonSchema, TS)]
pub struct SqlResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub count: u64,
    pub truncated: bool,
}
dto!(SqlError { message: String, code: Option<String>, detail: Option<String>, hint: Option<String>, position: Option<u32> });
#[derive(Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum SqlResponse {
    Success {
        results: Vec<SqlResult>,
        results_truncated: bool,
    },
    Failure {
        error: SqlError,
    },
}

/// Transitional database JSON aggregation is checked at the module boundary.
pub(crate) fn response<T: serde::de::DeserializeOwned>(
    value: serde_json::Value,
) -> Result<axum::Json<T>, crate::ApiError> {
    serde_json::from_value(value)
        .map(axum::Json)
        .map_err(|error| {
            tracing::error!(%error, "invalid panel response contract");
            crate::ApiError::from("invalid panel response contract")
        })
}

/// Deterministic output; tests fail when a Rust change was not regenerated.
pub fn exports() -> (String, String) {
    let config = ts_rs::Config::default().with_large_int("number");
    let mut types = String::from(
        "// Generated by cargo run -p nelcota-admin --example export_contracts. Do not edit.\n",
    );
    let mut schemas = serde_json::Map::new();
    macro_rules! export {
        ($($ty:ty),* $(,)?) => { $(
            types.push_str("export "); types.push_str(&<$ty>::decl(&config)); types.push('\n');
            let schema = schemars::generate::SchemaSettings::draft2020_12().for_serialize().into_generator().into_root_schema_for::<$ty>();
            schemas.insert(<$ty>::ident(&config), serde_json::to_value(schema).expect("schema serializes"));
        )* };
    }
    export!(
        RlsState,
        Rls,
        TableSummary,
        TablesResponse,
        Counts,
        Grants,
        OverviewTable,
        Overview,
        ColumnReference,
        Column,
        TableInfo,
        TableData,
        User,
        UsersResponse,
        Policy,
        PolicyTable,
        PoliciesData,
        ProjectLink,
        ProjectsData,
        ProjectStatus,
        ProjectsStatusData,
        Migration,
        PendingChange,
        MigrationsData,
        DeployToken,
        DeployTokenInfo,
        DeployTokens,
        ExportedMigration,
        Bucket,
        StorageBackend,
        StorageEnabled,
        StorageOverview,
        StoredFile,
        StorageListing,
        SchemaResponse,
        StoragePolicy,
        StorageAccess,
        DeniedRequest,
        DeniedRequests,
        MetricsPoint,
        MetricsTotals,
        MetricsResponse,
        SignInProviders,
        SignIn,
        TypesResponse,
        AvatarCrop,
        AvatarEditor,
        WebhookEndpoint,
        WebhookEndpoints,
        WebhookSecret,
        WebhookDelivery,
        WebhookDeliveries,
        WebhookAttempt,
        WebhookDetail,
        WebhookReplay,
        WebhookCleared,
        DdlResult,
        SqlResult,
        SqlError,
        SqlResponse
    );
    export!(
        crate::tables::structure::ForeignKeyRef,
        crate::tables::structure::ColumnInfo,
        crate::tables::structure::Grant,
        crate::tables::structure::Structure,
        crate::ddl::ApiRole,
        crate::ddl::Privilege,
        crate::ddl::GrantDef,
        crate::ddl::table::OnDelete,
        crate::ddl::table::ReferenceDef,
        crate::ddl::table::ColumnDef,
        crate::ddl::table::CreateTable,
        crate::ddl::table::AlterAction,
        crate::ddl::policy::Command,
        crate::ddl::policy::PolicyRole,
        crate::ddl::policy::PolicyDef
    );
    // Controller responses (nelcota-deployment) get a schema only: the panel
    // keeps its own TypeScript types for them.
    let controller = schemars::generate::SchemaSettings::draft2020_12()
        .for_serialize()
        .with_transform(schemars::transform::RecursiveTransform(safe_integer));
    macro_rules! schema_only {
        ($($name:literal => $ty:ty),* $(,)?) => { $(
            let schema = controller.clone().into_generator().into_root_schema_for::<$ty>();
            schemas.insert($name.into(), serde_json::to_value(schema).expect("schema serializes"));
        )* };
    }
    {
        use nelcota_deployment::{PublicJob, alerts, management, operations, protocol};
        schema_only!(
            "HostAlertStatus" => alerts::Status,
            "HostAlertSettings" => alerts::Settings,
            "HostDiagnostics" => operations::Diagnostics,
            "HostConfigurationView" => operations::ConfigurationView,
            "HostStatus" => management::Status,
            "HostPlan" => management::Plan,
            "HostJob" => management::PublicJob,
            "HostOperation" => management::Operation,
            "HostLogEntry" => management::LogEntry,
            "UpdateStatus" => protocol::Status,
            "UpdatePlan" => protocol::UpdatePlan,
            "UpdateJob" => PublicJob,
        );
    }
    types.push_str("export type RowData = Record<string, string | null>;\n");
    let types = types
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    (
        types,
        serde_json::to_string_pretty(&schemas).expect("schemas serialize") + "\n",
    )
}

/// Larger integers lose precision in `JSON.parse`; the hand-written panel checks rejected them too.
fn safe_integer(schema: &mut schemars::Schema) {
    const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;
    let signed = match schema.get("format").and_then(serde_json::Value::as_str) {
        Some("uint64" | "uint") => false,
        Some("int64" | "int") => true,
        _ => return,
    };
    if schema.get("maximum").is_none() {
        schema.insert("maximum".into(), MAX_SAFE_INTEGER.into());
    }
    if signed && schema.get("minimum").is_none() {
        schema.insert("minimum".into(), (-MAX_SAFE_INTEGER).into());
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn generated_contracts_are_current() {
        let (types, schemas) = super::exports();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ui/src/lib/generated");
        assert_eq!(
            types,
            std::fs::read_to_string(root.join("contracts.ts")).expect("run bun run contracts")
        );
        assert_eq!(
            schemas,
            std::fs::read_to_string(root.join("schemas.json")).expect("run bun run contracts")
        );
    }

    fn exported() -> serde_json::Value {
        serde_json::from_str(&super::exports().1).expect("schemas are JSON")
    }

    #[test]
    fn wide_integers_stay_within_the_javascript_safe_range() {
        let mut unsigned =
            schemars::json_schema!({ "type": "integer", "format": "uint64", "minimum": 0 });
        super::safe_integer(&mut unsigned);
        assert_eq!(
            unsigned.get("maximum"),
            Some(&serde_json::json!(9_007_199_254_740_991_i64))
        );
        assert_eq!(unsigned.get("minimum"), Some(&serde_json::json!(0)));

        let mut signed = schemars::json_schema!({ "type": "integer", "format": "int64" });
        super::safe_integer(&mut signed);
        assert_eq!(
            signed.get("maximum"),
            Some(&serde_json::json!(9_007_199_254_740_991_i64))
        );
        assert_eq!(
            signed.get("minimum"),
            Some(&serde_json::json!(-9_007_199_254_740_991_i64))
        );

        let mut bounded =
            schemars::json_schema!({ "type": "integer", "format": "uint64", "maximum": 32 });
        super::safe_integer(&mut bounded);
        assert_eq!(bounded.get("maximum"), Some(&serde_json::json!(32)));

        let mut small = schemars::json_schema!({ "type": "integer", "format": "uint32" });
        super::safe_integer(&mut small);
        assert_eq!(small.get("maximum"), None);
    }

    #[test]
    fn each_alert_status_field_allows_only_its_own_codes() {
        let schemas = exported();
        let status = &schemas["HostAlertStatus"]["properties"];
        let allowed = |codes: &[&str]| {
            let mut values: Vec<serde_json::Value> =
                codes.iter().map(|code| (*code).into()).collect();
            values.push(serde_json::Value::Null);
            serde_json::Value::Array(values)
        };
        assert_eq!(
            status["heartbeat_error"]["enum"],
            allowed(&nelcota_deployment::alerts::HEARTBEAT_ERRORS)
        );
        assert_eq!(
            status["monitor_error"]["enum"],
            allowed(&nelcota_deployment::alerts::MONITOR_ERRORS)
        );
    }

    #[test]
    fn project_patterns_match_the_rust_validators() {
        let schemas = exported();
        let pattern = |value: &serde_json::Value| {
            regex::Regex::new(value.as_str().expect("pattern is a string"))
                .expect("pattern compiles")
        };
        let project =
            pattern(&schemas["HostStatus"]["$defs"]["Project"]["properties"]["name"]["pattern"]);
        let operation =
            pattern(&schemas["HostOperation"]["oneOf"][1]["properties"]["project"]["pattern"]);
        let long = "a".repeat(32);
        let too_long = "a".repeat(33);
        for name in [
            "shop", "a", "0", "shop-2", "-shop", "shop-", "-", "a--b", &long, &too_long, "",
            "Shop", "shop_2", "shop.2", "loja ", "çafé",
        ] {
            assert_eq!(
                project.is_match(name),
                nelcota_deployment::valid_project(name),
                "project pattern disagrees with valid_project on {name:?}"
            );
            let operation_valid = nelcota_deployment::management::Operation::Backup {
                project: name.into(),
            }
            .validate()
            .is_ok();
            assert_eq!(
                operation.is_match(name),
                operation_valid,
                "operation pattern disagrees with Operation::validate on {name:?}"
            );
        }
    }
}
