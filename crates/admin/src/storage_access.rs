//! Who may read and write the files of a bucket: the policies on
//! `storage.objects` that apply to it, and policies created from a few
//! templates. The SQL is built here from the bucket id (never from browser
//! text) and applied like any panel DDL, so it is recorded for migrations.
use crate::{
    AdminState, ApiError,
    apply::{ChangeKind, apply},
    ddl::{
        literal,
        policy::{self, Command, PolicyDef, PolicyRole},
    },
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;

const SCHEMA: &str = "storage";
const TABLE: &str = "objects";

type ApiResult<T> = Result<Json<T>, ApiError>;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Template {
    /// Anyone, signed in or not, can download.
    PublicRead,
    /// Signed-in users can download.
    SignedInRead,
    /// Signed-in users can upload.
    SignedInUpload,
    /// Each user reads and writes only the folder named after their id.
    OwnFolder,
    /// Each user reads and writes only the files they uploaded.
    OwnFiles,
}

impl Template {
    fn slug(self) -> &'static str {
        match self {
            Template::PublicRead => "public_read",
            Template::SignedInRead => "signed_in_read",
            Template::SignedInUpload => "signed_in_upload",
            Template::OwnFolder => "own_folder",
            Template::OwnFiles => "own_files",
        }
    }

    /// The policy for `bucket` (an id already checked to exist).
    pub fn policy(self, bucket: &str) -> PolicyDef {
        let in_bucket = format!("bucket_id = {}", literal(bucket));
        let folder = format!("{in_bucket} AND (storage.foldername(name))[1] = auth.uid()::text");
        let owner = format!("{in_bucket} AND owner = auth.uid()");
        let (command, roles, using, check) = match self {
            Template::PublicRead => (
                Command::Select,
                vec![PolicyRole::Anon, PolicyRole::Authenticated],
                Some(in_bucket),
                None,
            ),
            Template::SignedInRead => (
                Command::Select,
                vec![PolicyRole::Authenticated],
                Some(in_bucket),
                None,
            ),
            Template::SignedInUpload => (
                Command::Insert,
                vec![PolicyRole::Authenticated],
                None,
                Some(in_bucket),
            ),
            Template::OwnFolder => (
                Command::All,
                vec![PolicyRole::Authenticated],
                Some(folder.clone()),
                Some(folder),
            ),
            Template::OwnFiles => (
                Command::All,
                vec![PolicyRole::Authenticated],
                Some(owner.clone()),
                Some(owner),
            ),
        };
        PolicyDef {
            name: policy_name(bucket, self.slug()),
            command,
            roles,
            permissive: true,
            using,
            check,
        }
    }
}

/// `<bucket>_<template>`, within Postgres' 63-byte identifiers.
fn policy_name(bucket: &str, slug: &str) -> String {
    let room = 63 - slug.len() - 1;
    let end = bucket.floor_char_boundary(room);
    let bucket = &bucket[..end];
    format!("{bucket}_{slug}")
}

/// Whether a policy limits itself to `bucket` (`bucket_id = '<id>'` in its
/// expressions); `None` when it names no bucket at all, so it covers every one.
fn scope(bucket: &str, expressions: [Option<&str>; 2]) -> Option<bool> {
    let text: String = expressions
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if !text.contains("bucket_id") {
        return None;
    }
    Some(text.contains(&literal(bucket)))
}

async fn bucket_public(state: &AdminState, id: &str) -> Result<bool, ApiError> {
    let client = state.db.get().await?;
    client
        .query_opt("SELECT public FROM storage.buckets WHERE id = $1", &[&id])
        .await?
        .map(|row| row.get(0))
        .ok_or_else(|| ApiError::not_found("bucket_not_found", "bucket not found"))
}

/// `GET /admin/api/storage/buckets/{id}/access`
pub async fn access(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> ApiResult<crate::contracts::StorageAccess> {
    let public = bucket_public(&state, &id).await?;
    let client = state.db.get().await?;
    let rows = client
        .query(
            "SELECT policyname::text, cmd, roles::text[], qual, with_check
               FROM pg_policies WHERE schemaname = $1 AND tablename = $2
              ORDER BY policyname",
            &[&SCHEMA, &TABLE],
        )
        .await?;
    let policies = rows
        .iter()
        .filter_map(|row| {
            let using: Option<String> = row.get(3);
            let check: Option<String> = row.get(4);
            let all_buckets = match scope(&id, [using.as_deref(), check.as_deref()]) {
                None => true,
                Some(true) => false,
                Some(false) => return None,
            };
            Some(crate::contracts::StoragePolicy {
                name: row.get(0),
                command: row.get(1),
                roles: row.get(2),
                using,
                check,
                all_buckets,
            })
        })
        .collect();
    Ok(Json(crate::contracts::StorageAccess {
        bucket: id,
        public,
        policies,
    }))
}

#[derive(Deserialize)]
pub struct CreateRequest {
    template: Template,
    #[serde(default)]
    preview: bool,
}

/// `POST /admin/api/storage/buckets/{id}/access`
pub async fn create(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    Json(body): Json<CreateRequest>,
) -> ApiResult<crate::contracts::DdlResult> {
    bucket_public(&state, &id).await?;
    let def = body.template.policy(&id);
    let statements = policy::create(SCHEMA, TABLE, &def)?;
    apply(
        &state,
        statements,
        body.preview,
        ChangeKind::PolicyCreated,
        &def.name,
    )
    .await
}

#[derive(Deserialize)]
pub struct DropQuery {
    #[serde(default)]
    preview: bool,
}

/// `DELETE /admin/api/storage/buckets/{id}/access/{policy}`
pub async fn drop(
    State(state): State<AdminState>,
    Path((id, name)): Path<(String, String)>,
    Query(params): Query<DropQuery>,
) -> ApiResult<crate::contracts::DdlResult> {
    bucket_public(&state, &id).await?;
    let statements = policy::drop(SCHEMA, TABLE, &name);
    apply(
        &state,
        statements,
        params.preview,
        ChangeKind::PolicyDropped,
        &name,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_scope_every_policy_to_the_bucket() {
        let sql = policy::create(SCHEMA, TABLE, &Template::OwnFolder.policy("avatars")).unwrap();
        assert_eq!(
            sql,
            [
                "CREATE POLICY \"avatars_own_folder\" ON \"storage\".\"objects\" AS PERMISSIVE FOR ALL \
                 TO \"authenticated\" USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text) \
                 WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)"
            ]
        );
        let read = policy::create(SCHEMA, TABLE, &Template::PublicRead.policy("docs")).unwrap();
        assert!(
            read[0]
                .contains("FOR SELECT TO \"anon\", \"authenticated\" USING (bucket_id = 'docs')")
        );
        let upload =
            policy::create(SCHEMA, TABLE, &Template::SignedInUpload.policy("docs")).unwrap();
        assert!(
            upload[0].ends_with("FOR INSERT TO \"authenticated\" WITH CHECK (bucket_id = 'docs')")
        );
    }

    #[test]
    fn names_fit_in_an_identifier() {
        let long = "b".repeat(63);
        let name = Template::SignedInUpload.policy(&long).name;
        assert_eq!(name.len(), 63);
        assert!(name.ends_with("_signed_in_upload"));
    }

    #[test]
    fn policies_are_scoped_by_their_bucket_literal() {
        assert_eq!(
            scope("docs", [Some("(bucket_id = 'docs'::text)"), None]),
            Some(true)
        );
        assert_eq!(
            scope("docs", [Some("(bucket_id = 'avatars'::text)"), None]),
            Some(false)
        );
        assert_eq!(scope("docs", [Some("(owner = auth.uid())"), None]), None);
        // `docs` must not match inside `my-docs`.
        assert_eq!(
            scope("docs", [Some("(bucket_id = 'my-docs'::text)"), None]),
            Some(false)
        );
    }
}
