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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LinkKind {
    Recovery,
    Signup,
    MagicLink,
}

impl LinkKind {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "recovery" => Some(LinkKind::Recovery),
            "signup" => Some(LinkKind::Signup),
            "magiclink" => Some(LinkKind::MagicLink),
            _ => None,
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            LinkKind::Recovery => "recovery",
            LinkKind::Signup => "signup",
            LinkKind::MagicLink => "magiclink",
        }
    }

    /// A magic link signs in by itself, so it lives the shortest; a signup
    /// confirmation may wait until the person checks their inbox.
    const fn ttl_minutes(self) -> i32 {
        match self {
            LinkKind::Recovery => 60,
            LinkKind::Signup => 24 * 60,
            LinkKind::MagicLink => 15,
        }
    }

    /// Only accounts still waiting for confirmation receive a signup link.
    const fn only_unconfirmed(self) -> bool {
        matches!(self, LinkKind::Signup)
    }
}

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
