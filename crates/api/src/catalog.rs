//! Postgres catalog introspection: tables, views, columns, types, PKs, FKs,
//! functions and the privileges of the API roles.
//!
//! The catalog is the source of truth for identifiers: no table, column or
//! function coming from the URL reaches SQL unless it exists here.

mod introspection;
mod listener;
mod model;
mod refresh;

pub use listener::{ReloadListener, spawn_reload_listener};
pub use model::{
    Argument, Catalog, Column, ForeignKey, Function, NamedType, Privileges, Table, TableKind,
    TypeField,
};
pub use refresh::CatalogHandle;

/// PostgreSQL notification channel for schema changes.
pub const RELOAD_CHANNEL: &str = "nelcota";
