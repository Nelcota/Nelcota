//! Versioned HMAC-SHA256 over the event id, send time and exact UTF-8 body.
use hmac::{Hmac, KeyInit, Mac};
use nelcota_core::config::Secret;
use sha2::Sha256;

pub fn generate_secret() -> Result<Secret, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(Secret::new(format!(
        "whsec_{}",
        base16ct::lower::encode_string(&bytes)
    )))
}

/// Header value: `v1=<hex>`. The key is the literal `whsec_...` string.
pub fn signature(secret: &str, event_id: &str, timestamp: u64, payload: &[u8]) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(event_id.as_bytes());
    mac.update(b".");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(payload);
    format!(
        "v1={}",
        base16ct::lower::encode_string(&mac.finalize().into_bytes())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_vector_and_every_signed_field_matters() {
        // Independent Python hashlib/hmac vector, also used by the receiver recipe.
        let signed = signature(
            "whsec_test",
            "event-123",
            1700000000,
            br#"{"hello":"world"}"#,
        );
        assert_eq!(
            signed,
            "v1=c2f424ced1d99b8a6e73a8186c5ad9b1f7815483ffc421ccfe130501b36d620c"
        );
        assert_ne!(
            signed,
            signature("other", "event-123", 1700000000, br#"{"hello":"world"}"#)
        );
        assert_ne!(
            signed,
            signature(
                "whsec_test",
                "event-124",
                1700000000,
                br#"{"hello":"world"}"#
            )
        );
        assert_ne!(
            signed,
            signature(
                "whsec_test",
                "event-123",
                1700000001,
                br#"{"hello":"world"}"#
            )
        );
        assert_ne!(
            signed,
            signature(
                "whsec_test",
                "event-123",
                1700000000,
                br#"{"hello":"World"}"#
            )
        );
    }
}
