//! Email and password rules for accounts. Shared by public signup
//! (`/auth/v1/signup`) and the panel, which creates users and resets
//! passwords: an account cannot follow different rules depending on who
//! created it.

/// Rejected credential; the message goes to whoever filled it in.
#[derive(Debug, PartialEq, Eq)]
pub struct InvalidCredential(pub &'static str);

const MAX_PASSWORD_CHARS: usize = 256;

/// Bound verification inputs without imposing creation-time minimum strength
/// on credentials imported from another password store.
pub(crate) fn password_exceeds_limit(password: &str) -> bool {
    password.chars().nth(MAX_PASSWORD_CHARS).is_some()
}

/// A simple mailbox address (ASCII dot-atom local part, DNS domain), matching
/// the SMTP address parser. Display names, quoted local parts and controls
/// are not account identifiers. Surrounding spaces are trimmed.
pub fn normalize_email(email: &str) -> Result<String, InvalidCredential> {
    if email.chars().any(char::is_control) {
        return Err(InvalidCredential("invalid email"));
    }
    let email = email.trim().to_lowercase();
    let valid = email.len() <= 254
        && !email.chars().any(char::is_whitespace)
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && local.len() <= 64
                && local.split('.').all(|part| {
                    !part.is_empty()
                        && part.bytes().all(|b| {
                            b.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~".contains(&b)
                        })
                })
                && domain.contains('.')
                && domain.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
        })
        && email.parse::<lettre::Address>().is_ok();
    if valid {
        return Ok(email);
    }
    Err(InvalidCredential("invalid email"))
}

pub fn validate_password(password: &str) -> Result<(), InvalidCredential> {
    match password.chars().take(MAX_PASSWORD_CHARS + 1).count() {
        0..8 => Err(InvalidCredential(
            "the password needs at least 8 characters",
        )),
        8..=MAX_PASSWORD_CHARS => Ok(()),
        _ => Err(InvalidCredential(
            "the password can have at most 256 characters",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_email() {
        assert_eq!(
            normalize_email("  Ana@Example.COM ").unwrap(),
            "ana@example.com"
        );
        for bad in [
            "",
            "ana",
            "@x.com",
            "ana@",
            "ana@x",
            "a b@x.com",
            "a@b@x.com",
            "ana\0@example.com",
            "\nana@example.com",
            "<victim@example.com>",
            "a@.com",
            "a..b@example.com",
            ".a@example.com",
            "a.@example.com",
            "a@example..com",
            "a@-example.com",
            "a@example-.com",
        ] {
            assert!(normalize_email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn password_length() {
        assert!(validate_password("1234567").is_err());
        assert!(validate_password("12345678").is_ok());
        // Counts characters, not bytes.
        assert!(validate_password("€€€€€€€€").is_ok());
        assert!(validate_password(&"x".repeat(257)).is_err());
    }
}
