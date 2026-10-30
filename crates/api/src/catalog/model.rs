//! Validated catalog data and role privileges.
use nelcota_core::Role;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Privileges {
    pub select: bool,
    pub insert: bool,
    pub update: bool,
    pub delete: bool,
}

impl Privileges {
    pub fn any(self) -> bool {
        self.select || self.insert || self.update || self.delete
    }

    /// What either grants.
    pub fn union(self, other: Privileges) -> Privileges {
        Privileges {
            select: self.select || other.select,
            insert: self.insert || other.insert,
            update: self.update || other.update,
            delete: self.delete || other.delete,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TableKind {
    Table,
    View,
    MaterializedView,
    ForeignTable,
}

#[derive(Clone, Debug, Serialize)]
pub struct Column {
    pub name: String,
    /// Type without modifier, as Postgres formats it (e.g. `character varying`,
    /// `integer[]`, `public.mood`). Used in casts.
    pub type_name: String,
    /// Type with modifier (e.g. `character varying(80)`), for documentation.
    pub full_type: String,
    /// Type category (`pg_type.typcategory`): N number, S text, B bool...
    pub category: char,
    /// Element type, for arrays.
    pub element_type: Option<String>,
    pub enum_values: Vec<String>,
    pub nullable: bool,
    pub has_default: bool,
    pub generated: bool,
    pub comment: Option<String>,
    /// SELECT/INSERT/UPDATE on this column (from a table or column GRANT) for
    /// anon, authenticated and service_role, in that order; `delete` is unused.
    #[serde(skip)]
    pub privileges: [Privileges; 3],
}

impl Column {
    pub fn privileges_for(&self, role: Role) -> Privileges {
        self.privileges[role_index(role)]
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub foreign_schema: String,
    pub foreign_table: String,
    pub foreign_columns: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Table {
    pub name: String,
    pub kind: TableKind,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
    pub rls_enabled: bool,
    pub rls_forced: bool,
    /// Views with this option use the caller's underlying privileges and RLS.
    pub security_invoker: bool,
    pub comment: Option<String>,
    /// Privileges of anon, authenticated and service_role (in that order).
    pub privileges: [Privileges; 3],
}

impl Table {
    pub fn column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.name == name)
    }

    pub fn privileges_for(&self, role: Role) -> Privileges {
        self.privileges[role_index(role)]
    }

    /// Relations that may expose rows without the caller's RLS. Ordinary
    /// views run under their owner's privileges; materialized and foreign
    /// tables have no local row policies. Invoker views use underlying RLS.
    pub fn exposed_without_rls(&self) -> bool {
        (match self.kind {
            TableKind::Table => !self.rls_enabled,
            TableKind::View => !self.security_invoker,
            TableKind::MaterializedView | TableKind::ForeignTable => true,
        }) && self.privileges[..2]
            .iter()
            .any(|p| p.select || p.insert || p.update || p.delete)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Argument {
    pub name: String,
    pub type_name: String,
    pub has_default: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Function {
    pub name: String,
    pub args: Vec<Argument>,
    pub return_type: String,
    pub returns_set: bool,
    pub returns_void: bool,
    /// `i` immutable, `s` stable, `v` volatile.
    pub volatility: char,
    pub comment: Option<String>,
    /// EXECUTE for anon, authenticated and service_role.
    pub executable: [bool; 3],
}

impl Function {
    pub fn executable_by(&self, role: Role) -> bool {
        self.executable[role_index(role)]
    }
}

#[derive(Clone, Debug, serde::Deserialize, Serialize)]
pub struct TypeField {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct NamedType {
    pub name: String,
    pub enum_values: Vec<String>,
    pub fields: Vec<TypeField>,
    pub relation: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Catalog {
    pub schema: String,
    /// Named enum/composite types keyed by PostgreSQL format_type, including RPC-only types.
    pub named_types: BTreeMap<String, NamedType>,
    pub tables: BTreeMap<String, Table>,
    /// Functions by name (there may be overloads).
    pub functions: BTreeMap<String, Vec<Function>>,
}

fn role_index(role: Role) -> usize {
    match role {
        Role::Anon => 0,
        Role::Authenticated => 1,
        Role::ServiceRole => 2,
    }
}

impl Catalog {
    pub fn table(&self, name: &str) -> Option<&Table> {
        self.tables.get(name)
    }
}
