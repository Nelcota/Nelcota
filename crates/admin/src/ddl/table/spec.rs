//! Typed table definitions and ordered alteration requests.
use crate::ddl::GrantDef;
use serde::Deserialize;

/// Context for validating types: the exposed schema and its enums.
pub struct Context<'a> {
    pub schema: &'a str,
    pub enums: &'a [String],
}

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, ts_rs::TS, schemars::JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum OnDelete {
    #[default]
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS, schemars::JsonSchema)]
pub struct ReferenceDef {
    pub table: String,
    pub column: String,
    #[serde(default)]
    pub on_delete: OnDelete,
}

const fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS, schemars::JsonSchema)]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
    #[serde(default = "yes")]
    pub nullable: bool,
    /// SQL expression (`now()`, `0`, `'draft'`).
    pub default: Option<String>,
    #[serde(default)]
    pub primary_key: bool,
    /// `GENERATED ALWAYS AS IDENTITY` (integer types only).
    #[serde(default)]
    pub identity: bool,
    #[serde(default)]
    pub unique: bool,
    pub references: Option<ReferenceDef>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ts_rs::TS, schemars::JsonSchema)]
pub struct CreateTable {
    pub name: String,
    pub comment: Option<String>,
    pub columns: Vec<ColumnDef>,
    /// RLS on from creation (the default): without policies, only service_role gets in.
    #[serde(default = "yes")]
    pub rls: bool,
    #[serde(default)]
    pub grants: Vec<GrantDef>,
}

/// One change. The whole list runs in one transaction, in the order sent.
#[derive(Debug, Clone, Deserialize, ts_rs::TS, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum AlterAction {
    RenameTable {
        name: String,
    },
    SetComment {
        comment: Option<String>,
    },
    SetRls {
        enabled: bool,
    },
    AddColumn {
        column: ColumnDef,
    },
    DropColumn {
        name: String,
    },
    RenameColumn {
        from: String,
        to: String,
    },
    /// `using`: conversion expression; default `"column"::new_type`.
    SetType {
        column: String,
        data_type: String,
        #[ts(optional = nullable)]
        using: Option<String>,
    },
    SetNullable {
        column: String,
        nullable: bool,
    },
    SetDefault {
        column: String,
        default: Option<String>,
    },
    SetUnique {
        column: String,
        unique: bool,
    },
    SetReference {
        column: String,
        reference: Option<ReferenceDef>,
    },
    SetColumnComment {
        column: String,
        comment: Option<String>,
    },
    /// Replaces the role's privileges on the table.
    SetGrants {
        grant: GrantDef,
    },
}
