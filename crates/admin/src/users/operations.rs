//! Account administration owns validation, persistence and transaction lifetimes.
use crate::{
    ApiError,
    contracts::{User, UsersResponse},
};
use deadpool_postgres::Pool;
use nelcota_auth::{Passwords, normalize_email, validate_password};
use serde_json::json;
use tokio_postgres::error::SqlState;

pub(super) struct CreatedUser {
    pub id: String,
    pub email: String,
}

pub(super) async fn list(pool: &Pool, page: i64, search: &str) -> Result<UsersResponse, ApiError> {
    const SIZE: i64 = 50;
    let page = page.max(0);
    let offset = page
        .checked_mul(SIZE)
        .ok_or_else(|| ApiError::bad_request("invalid_page", "page is too large"))?;
    let (pattern, id) = search_terms(search);
    let client = pool.get().await?;
    let rows = client.query(
        "SELECT u.id::text, u.email, u.created_at::text, u.last_sign_in_at::text,
                u.email_confirmed_at::text,
                (SELECT count(*) FROM auth.sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL),
                u.encrypted_password IS NOT NULL,
                -- Sign-in providers linked to the account (D91), in a stable order.
                ARRAY(SELECT i.provider FROM auth.identities i WHERE i.user_id = u.id ORDER BY i.provider)
         FROM auth.users u WHERE u.email ILIKE $1 OR u.id::text = $4
         ORDER BY u.created_at DESC, u.id DESC LIMIT $2 OFFSET $3",
        &[&pattern, &(SIZE + 1), &offset, &id],
    ).await?;
    let total = client
        .query_one("SELECT count(*) FROM auth.users", &[])
        .await?
        .get(0);
    Ok(UsersResponse {
        total,
        page,
        has_next: rows.len() as i64 > SIZE,
        users: rows
            .iter()
            .take(SIZE as usize)
            .map(|row| User {
                id: row.get(0),
                email: row.get(1),
                created_at: row.get(2),
                last_sign_in_at: row.get(3),
                email_confirmed_at: row.get(4),
                sessions: row.get(5),
                has_password: row.get(6),
                providers: row.get(7),
            })
            .collect(),
    })
}

/// Search box terms: an ILIKE pattern matching the email anywhere (case
/// insensitive, with `\`, `%` and `_` taken literally) and the trimmed,
/// lowercased text compared to the user id, so a pasted UUID finds its user.
fn search_terms(search: &str) -> (String, String) {
    let search = search.trim();
    let pattern = format!(
        "%{}%",
        search
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    (pattern, search.to_ascii_lowercase())
}

/// UUID format check (8-4-4-4-12 hex), before querying PostgreSQL.
fn check_id(value: &str) -> Result<(), ApiError> {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Ok(());
    }
    Err(ApiError::bad_request("invalid_id", "invalid id"))
}

pub(super) async fn revoke_sessions(pool: &Pool, id: &str) -> Result<u64, ApiError> {
    check_id(id)?;
    let client = pool.get().await?;
    Ok(client.execute(
        "UPDATE auth.sessions SET revoked_at = now() WHERE user_id = $1::text::uuid AND revoked_at IS NULL",
        &[&id],
    ).await?)
}

pub(super) async fn delete(pool: &Pool, id: &str) -> Result<(), ApiError> {
    check_id(id)?;
    let client = pool.get().await?;
    let deleted = client
        .execute("DELETE FROM auth.users WHERE id = $1::text::uuid", &[&id])
        .await?;
    if deleted == 0 {
        return Err(user_not_found());
    }
    Ok(())
}

/// Marks the email as confirmed; already confirmed accounts keep their date.
pub(super) async fn confirm_email(pool: &Pool, id: &str) -> Result<(), ApiError> {
    check_id(id)?;
    let client = pool.get().await?;
    let updated = client
        .execute(
            "UPDATE auth.users SET email_confirmed_at = coalesce(email_confirmed_at, now())
             WHERE id = $1::text::uuid",
            &[&id],
        )
        .await?;
    if updated == 0 {
        return Err(user_not_found());
    }
    tracing::info!("email confirmed by the panel");
    Ok(())
}

fn user_not_found() -> ApiError {
    ApiError::not_found("user_not_found", "user not found")
}

// Kept in sync with nelcota_auth::validate_password for translated error parameters.
const MAX_PASSWORD: usize = 256;
const MIN_PASSWORD: usize = 8;

fn check_password(password: &str) -> Result<(), ApiError> {
    validate_password(password).map_err(|error| {
        let code = match password.chars().count() < MIN_PASSWORD {
            true => "password_too_short",
            false => "password_too_long",
        };
        ApiError::bad_request(code, error.0)
            .params(json!({ "min": MIN_PASSWORD, "max": MAX_PASSWORD }))
    })
}

/// Expensive hashing runs outside the async runtime's threads.
async fn hash(passwords: &Passwords, password: String) -> Result<String, ApiError> {
    passwords
        .hash(password)
        .await
        .ok_or_else(|| ApiError::from("failed to hash the password"))
}

pub(super) async fn create(
    pool: &Pool,
    passwords: &Passwords,
    email: &str,
    password: String,
) -> Result<CreatedUser, ApiError> {
    let email = normalize_email(email)
        .map_err(|_| ApiError::bad_request("invalid_email", "invalid email"))?;
    check_password(&password)?;
    let hash = hash(passwords, password).await?;
    let client = pool.get().await?;
    let row = client
        .query_one(
            // The administrator vouches for the address: with signup
            // confirmation on, the account can sign in right away.
            "INSERT INTO auth.users (email, encrypted_password, email_confirmed_at)
             VALUES ($1, $2, now()) RETURNING id::text",
            &[&email, &hash],
        )
        .await
        .map_err(
            |error| match error.code() == Some(&SqlState::UNIQUE_VIOLATION) {
                true => ApiError::conflict(
                    "user_already_exists",
                    "a user with this email already exists",
                ),
                false => ApiError::from(error),
            },
        )?;
    tracing::info!("user created by the panel");
    Ok(CreatedUser {
        id: row.get(0),
        email,
    })
}

/// A password change and session revocation commit together.
pub(super) async fn set_password(
    pool: &Pool,
    passwords: &Passwords,
    id: &str,
    password: String,
) -> Result<u64, ApiError> {
    check_id(id)?;
    check_password(&password)?;
    let hash = hash(passwords, password).await?;
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let updated = tx.execute(
        "UPDATE auth.users SET encrypted_password = $2, updated_at = now() WHERE id = $1::text::uuid",
        &[&id, &hash],
    ).await?;
    if updated == 0 {
        return Err(user_not_found());
    }
    // The password UPDATE holds the account lock used by credential redemption.
    // Retain token history so resetting a password does not reset send cooldowns.
    tx.execute(
        "UPDATE auth.one_time_tokens SET used_at = now() WHERE user_id = $1::text::uuid AND used_at IS NULL",
        &[&id],
    ).await?;
    tx.execute(
        "DELETE FROM auth.flow_states WHERE user_id = $1::text::uuid",
        &[&id],
    )
    .await?;
    let sessions = tx.execute(
        "UPDATE auth.sessions SET revoked_at = now() WHERE user_id = $1::text::uuid AND revoked_at IS NULL",
        &[&id],
    ).await?;
    tx.commit().await?;
    tracing::info!(sessions, "password reset by the panel");
    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::{check_id, search_terms};

    #[test]
    fn search_terms_escape_wildcards_and_normalize_the_id() {
        assert_eq!(search_terms(""), ("%%".into(), String::new()));
        assert_eq!(
            search_terms(" a_b%c\\ "),
            ("%a\\_b\\%c\\\\%".into(), "a_b%c\\".into())
        );
        assert_eq!(
            search_terms("054F8CD2-DECB-4C78-91A1-F351BD8F5B92").1,
            "054f8cd2-decb-4c78-91a1-f351bd8f5b92"
        );
    }

    #[test]
    fn validates_uuid() {
        assert!(check_id("054f8cd2-decb-4c78-91a1-f351bd8f5b92").is_ok());
        assert!(check_id("not-a-uuid").is_err());
        assert!(check_id("054f8cd2-decb-4c78-91a1-f351bd8f5b9z").is_err());
    }
}
