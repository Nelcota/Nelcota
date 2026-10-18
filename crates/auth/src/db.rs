//! Auth-role transactions and shared user projection.
use deadpool_postgres::{Object, Transaction};
use nelcota_core::{ApiError, Role};
pub(crate) fn db_error(err: tokio_postgres::Error) -> ApiError {
    ApiError::from_db(err, Role::ServiceRole)
}

pub(crate) async fn begin_auth(client: &mut Object) -> Result<Transaction<'_>, ApiError> {
    let tx = client.transaction().await.map_err(db_error)?;
    tx.batch_execute("SET LOCAL ROLE nelcota_auth")
        .await
        .map_err(db_error)?;
    Ok(tx)
}

pub(crate) const USER_JSON: &str = "json_build_object(
    'id', u.id,
    'email', u.email,
    'email_confirmed_at', u.email_confirmed_at,
    'user_metadata', u.raw_user_meta_data,
    'created_at', u.created_at,
    'last_sign_in_at', u.last_sign_in_at)";

/// Call while holding the account row lock, in the password-write transaction.
/// Keep issuance rows so password changes do not reset email send cooldowns.
pub(crate) async fn retire_pending_credentials(
    tx: &Transaction<'_>,
    user_id: uuid::Uuid,
) -> Result<(), ApiError> {
    tx.execute(
        "UPDATE auth.one_time_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
        &[&user_id],
    )
    .await
    .map_err(db_error)?;
    tx.execute(
        "DELETE FROM auth.flow_states WHERE user_id = $1",
        &[&user_id],
    )
    .await
    .map_err(db_error)?;
    Ok(())
}
