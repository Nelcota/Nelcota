//! Panel integration scenarios grouped by feature, sharing the production harness.
mod common;

#[path = "admin/access.rs"]
mod access;
#[path = "admin/assets.rs"]
mod assets;
#[path = "admin/auth.rs"]
mod auth;
#[path = "admin/migrations.rs"]
mod migrations;
#[path = "admin/overview.rs"]
mod overview;
#[path = "admin/pagination.rs"]
mod pagination;
#[path = "admin/performance.rs"]
mod performance;
#[path = "admin/policies.rs"]
mod policies;
#[path = "admin/profile.rs"]
mod profile;
#[path = "admin/projects.rs"]
mod projects;
#[path = "admin/sql.rs"]
mod sql;
#[path = "admin/sso.rs"]
mod sso;
#[path = "admin/tables.rs"]
mod tables;
#[path = "admin/tokens.rs"]
mod tokens;
#[path = "admin/users.rs"]
mod users;
