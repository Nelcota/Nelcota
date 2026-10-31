//! PKCE (RFC 7636) with S256, the only method accepted.
use oauth2::{PkceCodeChallenge, PkceCodeVerifier};

/// The S256 challenge of a verifier: base64url(SHA-256(verifier)).
pub(crate) fn challenge(verifier: &str) -> String {
    PkceCodeChallenge::from_code_verifier_sha256(&PkceCodeVerifier::new(verifier.into()))
        .as_str()
        .into()
}

/// Whether `verifier` is a valid verifier whose S256 challenge is `challenge`.
pub(crate) fn proves(verifier: &str, challenge: &str) -> bool {
    valid_verifier(verifier) && self::challenge(verifier) == challenge
}

/// A verifier as RFC 7636 defines it: 43 to 128 unreserved characters.
pub(crate) fn valid_verifier(verifier: &str) -> bool {
    (43..=128).contains(&verifier.len())
        && verifier
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-._~".contains(&c))
}

/// An S256 challenge: the 43-character base64url form of 32 bytes.
pub(crate) fn valid_challenge(challenge: &str) -> bool {
    challenge.len() == 43
        && challenge
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_7636_example() {
        // Appendix B of RFC 7636.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert!(valid_verifier(verifier));
        assert_eq!(
            challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(valid_challenge(&challenge(verifier)));
        assert!(proves(
            verifier,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        ));
        assert!(!proves(
            verifier,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN"
        ));
    }

    #[test]
    fn rejects_malformed_values() {
        assert!(!valid_verifier("short"));
        assert!(!valid_verifier(&"a".repeat(129)));
        assert!(!valid_verifier(&format!("{}+", "a".repeat(43))));
        assert!(!valid_challenge("plain-text-is-not-accepted"));
        assert!(!valid_challenge(&"a".repeat(44)));
    }
}
