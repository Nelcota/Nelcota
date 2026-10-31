//! Signup confirmation policy.
//!
//! With `NELCOTA_EMAIL_CONFIRMATION_URL` set, signup creates the account and
//! emails a confirmation link instead of opening a session, and password
//! sign-in waits until the email is confirmed (by that link, a magic link or a
//! recovery link).
use axum::http::StatusCode;
use deadpool_postgres::Transaction;
use nelcota_core::ApiError;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AuthState,
    db::{USER_JSON, db_error},
    links::{self, LinkKind},
};

pub(crate) fn required(state: &AuthState) -> bool {
    links::ensure_enabled(state, LinkKind::Signup).is_ok()
}

/// Password sign-in of an account whose email is not confirmed yet.
pub(crate) fn ensure_confirmed(state: &AuthState, confirmed: bool) -> Result<(), ApiError> {
    if confirmed || !required(state) {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::BAD_REQUEST,
        "email_not_confirmed",
        "confirm the email before signing in",
    ))
}

/// A signup waiting for confirmation: stores the link in `tx` and answers with
/// the account and no session. The returned token goes out with
/// [`links::deliver`] once `tx` commits. `code_challenge` binds the link to
/// the client that signed up (see [`links::sign_in`]).
pub(crate) async fn pending_signup(
    tx: &Transaction<'_>,
    user_id: Uuid,
    code_challenge: Option<&str>,
) -> Result<(Value, Option<String>), ApiError> {
    let token = links::issue(tx, user_id, LinkKind::Signup, code_challenge).await?;
    let user: Value = tx
        .query_one(
            &format!("SELECT {USER_JSON} FROM auth.users u WHERE u.id = $1"),
            &[&user_id],
        )
        .await
        .map_err(db_error)?
        .get(0);
    Ok((json!({ "user": user }), token))
}
