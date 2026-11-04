//! Single-use links sent by email: password recovery, signup confirmation and
//! magic link sign-in.
//!
//! Every kind shares the same life: a token is stored only as SHA-256 in
//! `auth.one_time_tokens`, goes to the app page configured for its kind (in the
//! URL fragment, `#type=<kind>&token=...`), expires and works once.

mod emails;
mod send;
mod sign_in;
mod tokens;

pub(crate) use send::{deliver, ensure_enabled, notify_existing_signup, send};
pub(crate) use sign_in::sign_in;
pub(crate) use tokens::{consume, hash, is_valid, issue};

/// What a link does when opened. The string form is the `type` of the API and
/// the `kind` column.
pub(crate) use nelcota_core::email::Kind as LinkKind;

#[cfg(test)]
mod tests {
    use super::LinkKind;

    #[test]
    fn kinds_round_trip_through_their_api_names() {
        for kind in [LinkKind::Recovery, LinkKind::Signup, LinkKind::MagicLink] {
            assert_eq!(LinkKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(LinkKind::parse("email"), None);
    }
}
