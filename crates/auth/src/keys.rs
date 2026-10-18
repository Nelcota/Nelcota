//! JWT signing keys, local verification and the public JWKS.
//!
//! - EdDSA (Ed25519) is the default: the public key goes into the JWKS, and any
//!   service can validate our tokens without knowing any secret.
//! - HS256 is the simple/legacy mode (shared secret, never published).

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use jsonwebtoken::{
    Algorithm, DecodingKey, EncodingKey, Header, Validation,
    jwk::{AlgorithmParameters, Jwk, JwkSet, PublicKeyUse},
};
use nelcota_core::Claims;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{JwtVerifier, VerifyError};

/// ASN.1 header of an Ed25519 private key in PKCS#8 v1 (RFC 8410), followed
/// by the 32 seed bytes.
const ED25519_PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("invalid Ed25519 private key: {0}")]
    InvalidPrivateKey(String),
    #[error("no signing key configured")]
    NoKey,
    #[error("HS256 secret must contain at least 32 bytes")]
    WeakSecret,
}

struct Signer {
    header: Header,
    key: EncodingKey,
}

struct EdVerifier {
    kid: String,
    key: DecodingKey,
    validation: Validation,
}

struct HsVerifier {
    key: DecodingKey,
    validation: Validation,
}

/// The server's key set: signs tokens, verifies them and publishes the JWKS.
pub struct Keys {
    signer: Signer,
    ed: Option<EdVerifier>,
    hs: Option<HsVerifier>,
    jwks: String,
}

const JWT_LEEWAY_SECS: u64 = 30;

fn validation(alg: Algorithm) -> Validation {
    let mut validation = Validation::new(alg);
    validation.leeway = JWT_LEEWAY_SECS;
    // `aud` is informative in the contract (docs/jwt-and-roles.md): not required.
    validation.validate_aud = false;
    validation
}

impl Keys {
    /// `private_key`: PKCS#8 Ed25519 as PEM or base64 (one line).
    /// `hs256_secret`: HS256 secret. With both, signs with EdDSA and accepts
    /// either when verifying (useful to migrate away from HS256).
    pub fn new(private_key: Option<&str>, hs256_secret: Option<&[u8]>) -> Result<Self, KeyError> {
        if hs256_secret.is_some_and(|secret| secret.len() < 32) {
            return Err(KeyError::WeakSecret);
        }
        let ed = private_key.map(parse_ed25519).transpose()?;
        let hs = hs256_secret.map(|secret| HsVerifier {
            key: DecodingKey::from_secret(secret),
            validation: validation(Algorithm::HS256),
        });

        let (signer, ed_verifier, jwks) = match (ed, hs256_secret) {
            (Some((encoding, x, kid)), _) => {
                let mut header = Header::new(Algorithm::EdDSA);
                header.kid = Some(kid.clone());
                let mut jwk = Jwk::from_encoding_key(&encoding, Algorithm::EdDSA)
                    .map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?;
                jwk.common.key_id = Some(kid.clone());
                jwk.common.public_key_use = Some(PublicKeyUse::Signature);
                let verifier = EdVerifier {
                    kid,
                    key: DecodingKey::from_ed_components(&x)
                        .map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?,
                    validation: validation(Algorithm::EdDSA),
                };
                let jwks = JwkSet { keys: vec![jwk] };
                (
                    Signer {
                        header,
                        key: encoding,
                    },
                    Some(verifier),
                    jwks,
                )
            }
            (None, Some(secret)) => (
                Signer {
                    header: Header::new(Algorithm::HS256),
                    key: EncodingKey::from_secret(secret),
                },
                None,
                JwkSet { keys: vec![] },
            ),
            (None, None) => return Err(KeyError::NoKey),
        };

        Ok(Keys {
            signer,
            ed: ed_verifier,
            hs,
            jwks: serde_json::to_string(&jwks).expect("JwkSet serializes"),
        })
    }

    /// Signs a claims payload with the active key.
    pub fn sign(&self, claims: &Value) -> Result<String, jsonwebtoken::errors::Error> {
        jsonwebtoken::encode(&self.signer.header, claims, &self.signer.key)
    }

    /// JWT with `role: service_role`, valid for `days` days. **Bypasses RLS**:
    /// only for trusted backends. The single issuer (CLI and panel use it).
    pub fn service_role_token(
        &self,
        issuer: &str,
        days: u64,
    ) -> Result<String, jsonwebtoken::errors::Error> {
        let now = jsonwebtoken::get_current_timestamp();
        let expires_at = days
            .checked_mul(86_400)
            .and_then(|ttl| now.checked_add(ttl))
            .filter(|_| days > 0)
            .ok_or_else(|| {
                jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidToken)
            })?;
        self.sign(&serde_json::json!({
            "iss": issuer,
            "role": "service_role",
            "iat": now,
            "exp": expires_at,
        }))
    }

    /// Signing algorithm (`EdDSA` or `HS256`).
    pub fn algorithm(&self) -> Algorithm {
        self.signer.header.alg
    }

    /// Public JWKS (`{"keys": [...]}`); empty in HS256-only mode.
    pub fn jwks_json(&self) -> &str {
        &self.jwks
    }
}

impl Keys {
    /// Checks signature, expiry and optional time claims and returns the raw payload, without
    /// reading it as request claims. For tokens that are not API tokens, such
    /// as signed storage URLs.
    pub fn verify_payload(&self, token: &str) -> Result<Value, VerifyError> {
        let header = jsonwebtoken::decode_header(token)?;
        let data = match (header.alg, &self.ed, &self.hs) {
            (Algorithm::EdDSA, Some(ed), _) => {
                if header.kid.as_deref().is_some_and(|kid| kid != ed.kid) {
                    return Err(VerifyError::UnknownKey);
                }
                jsonwebtoken::decode::<Value>(token, &ed.key, &ed.validation)?
            }
            (Algorithm::HS256, _, Some(hs)) => {
                jsonwebtoken::decode::<Value>(token, &hs.key, &hs.validation)?
            }
            _ => return Err(VerifyError::UnknownKey),
        };
        validate_time_claims(&data.claims, jsonwebtoken::get_current_timestamp())?;
        Ok(data.claims)
    }
}

// Both signing algorithms and raw-payload consumers share this boundary.
// Absent claims remain compatible; present NumericDates must be whole,
// non-negative seconds, matching the documented expiration representation.
fn validate_time_claims(payload: &Value, now: u64) -> Result<(), VerifyError> {
    for claim in ["nbf", "iat"] {
        if let Some(value) = payload.get(claim) {
            let timestamp = value.as_u64().ok_or_else(|| {
                jsonwebtoken::errors::Error::from(jsonwebtoken::errors::ErrorKind::InvalidToken)
            })?;
            if timestamp > now.saturating_add(JWT_LEEWAY_SECS) {
                return Err(jsonwebtoken::errors::Error::from(
                    jsonwebtoken::errors::ErrorKind::ImmatureSignature,
                )
                .into());
            }
        }
    }
    Ok(())
}

impl JwtVerifier for Keys {
    fn verify(&self, token: &str) -> Result<Claims, VerifyError> {
        Ok(Claims::from_payload(self.verify_payload(token)?)?)
    }
}

/// Reads the private key and returns (key, public key `x`, kid).
fn parse_ed25519(input: &str) -> Result<(EncodingKey, String, String), KeyError> {
    let input = input.trim();
    let key = match input.contains("-----BEGIN") {
        true => EncodingKey::from_ed_pem(input.as_bytes())
            .map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?,
        false => {
            let der = STANDARD
                .decode(input)
                .map_err(|e| KeyError::InvalidPrivateKey(format!("base64: {e}")))?;
            EncodingKey::from_ed_der(&der)
        }
    };
    let jwk = Jwk::from_encoding_key(&key, Algorithm::EdDSA)
        .map_err(|e| KeyError::InvalidPrivateKey(e.to_string()))?;
    let params = match jwk.algorithm {
        AlgorithmParameters::OctetKeyPair(params) => params,
        _ => {
            return Err(KeyError::InvalidPrivateKey("not Ed25519".into()));
        }
    };
    // kid = JWK thumbprint (RFC 7638): stable for the same key.
    let canonical = format!(r#"{{"crv":"Ed25519","kty":"OKP","x":"{}"}}"#, params.x);
    let kid = URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()));
    Ok((key, params.x, kid))
}

/// Generates a new Ed25519 private key as base64 PKCS#8 (one line, fits in a
/// `.env`). Equivalent to `openssl genpkey -algorithm ed25519`.
pub fn generate_ed25519_private_key() -> String {
    let mut der = ED25519_PKCS8_PREFIX.to_vec();
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).expect("system randomness source unavailable");
    der.extend_from_slice(&seed);
    STANDARD.encode(der)
}

#[cfg(test)]
mod tests {
    #[test]
    fn service_token_rejects_unrepresentable_lifetimes() {
        let keys = super::Keys::new(Some(&super::generate_ed25519_private_key()), None).unwrap();
        assert!(keys.service_role_token("nelcota", u64::MAX).is_err());
    }

    #[test]
    fn reusable_keys_reject_short_hmac_secrets() {
        let mut secret = [0_u8; 31];
        getrandom::fill(&mut secret).unwrap();
        assert!(super::Keys::new(None, Some(&secret)).is_err());
        assert!(
            super::Keys::new(Some(&super::generate_ed25519_private_key()), Some(&secret)).is_err()
        );
    }

    use super::*;
    use serde_json::json;

    fn payload() -> Value {
        json!({
            "role": "authenticated",
            "sub": "7f9c24e8-3b12-4fef-91e0-3c7a5e4b9c1d",
            "exp": jsonwebtoken::get_current_timestamp() + 60,
        })
    }

    #[test]
    fn service_role_token_verifies_with_requested_lifetime() {
        let keys = Keys::new(Some(&generate_ed25519_private_key()), None).unwrap();
        let token = keys.service_role_token("nelcota", 30).unwrap();
        let claims = keys.verify(&token).unwrap();
        assert_eq!(claims.role(), nelcota_core::Role::ServiceRole);

        let payload: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(token.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap();
        let ttl = payload["exp"].as_u64().unwrap() - payload["iat"].as_u64().unwrap();
        assert_eq!(ttl, 30 * 86_400);
        assert_eq!(payload["iss"], "nelcota");
    }

    #[test]
    fn eddsa_signs_verifies_and_publishes_jwks() {
        let keys = Keys::new(Some(&generate_ed25519_private_key()), None).unwrap();
        assert_eq!(keys.algorithm(), Algorithm::EdDSA);
        let token = keys.sign(&payload()).unwrap();
        assert!(keys.verify(&token).is_ok());

        let jwks: Value = serde_json::from_str(keys.jwks_json()).unwrap();
        let jwk = &jwks["keys"][0];
        assert_eq!(jwk["kty"], "OKP");
        assert_eq!(jwk["crv"], "Ed25519");
        assert_eq!(jwk["alg"], "EdDSA");
        assert!(
            jwk.get("d").is_none(),
            "the JWKS must never contain the private part"
        );

        // A third party validates the token with the JWKS alone.
        let set: JwkSet = serde_json::from_value(jwks).unwrap();
        let key = DecodingKey::from_jwk(&set.keys[0]).unwrap();
        assert!(jsonwebtoken::decode::<Value>(&token, &key, &validation(Algorithm::EdDSA)).is_ok());
    }

    #[test]
    fn accepts_pkcs8_pem() {
        let b64 = generate_ed25519_private_key();
        let pem = format!("-----BEGIN PRIVATE KEY-----\n{b64}\n-----END PRIVATE KEY-----\n");
        let a = Keys::new(Some(&b64), None).unwrap();
        let b = Keys::new(Some(&pem), None).unwrap();
        assert_eq!(a.jwks_json(), b.jwks_json());
    }

    #[test]
    fn token_from_another_key_is_rejected() {
        let a = Keys::new(Some(&generate_ed25519_private_key()), None).unwrap();
        let b = Keys::new(Some(&generate_ed25519_private_key()), None).unwrap();
        assert!(b.verify(&a.sign(&payload()).unwrap()).is_err());
    }

    #[test]
    fn hs256_only_accepted_when_configured() {
        let secret = b"test-secret-with-more-than-32-characters";
        let hs = Keys::new(None, Some(secret)).unwrap();
        let token = hs.sign(&payload()).unwrap();
        assert!(hs.verify(&token).is_ok());
        assert_eq!(hs.jwks_json(), r#"{"keys":[]}"#);

        let ed_only = Keys::new(Some(&generate_ed25519_private_key()), None).unwrap();
        assert!(ed_only.verify(&token).is_err());
        let both = Keys::new(Some(&generate_ed25519_private_key()), Some(secret)).unwrap();
        assert!(both.verify(&token).is_ok());
    }

    #[test]
    fn invalid_key_errors() {
        assert!(Keys::new(Some("not-base64!"), None).is_err());
        assert!(Keys::new(Some("AAAA"), None).is_err());
        assert!(Keys::new(None, None).is_err());
    }
    fn time_claim_keys() -> [Keys; 2] {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).unwrap();
        [
            Keys::new(Some(&generate_ed25519_private_key()), Some(&secret)).unwrap(),
            Keys::new(None, Some(&secret)).unwrap(),
        ]
    }

    #[test]
    fn rejects_future_nbf_for_both_signing_algorithms() {
        for keys in time_claim_keys() {
            let mut claims = payload();
            claims["nbf"] = json!(jsonwebtoken::get_current_timestamp() + 300);
            let token = keys.sign(&claims).unwrap();
            assert!(keys.verify_payload(&token).is_err());
            assert!(keys.verify(&token).is_err());
        }
    }

    #[test]
    fn rejects_future_iat_for_both_signing_algorithms() {
        for keys in time_claim_keys() {
            let mut claims = payload();
            claims["iat"] = json!(jsonwebtoken::get_current_timestamp() + 300);
            let token = keys.sign(&claims).unwrap();
            assert!(keys.verify_payload(&token).is_err());
            assert!(keys.verify(&token).is_err());
        }
    }

    #[test]
    fn rejects_malformed_optional_time_claims() {
        for keys in time_claim_keys() {
            for name in ["nbf", "iat"] {
                for value in [
                    json!(null),
                    json!("123"),
                    json!(-1),
                    json!(1.5),
                    json!({}),
                    json!(true),
                ] {
                    let mut claims = payload();
                    claims[name] = value;
                    assert!(keys.verify_payload(&keys.sign(&claims).unwrap()).is_err());
                }
            }
        }
    }

    #[test]
    fn accepts_optional_time_claims_and_preserves_informative_issuer_audience() {
        for keys in time_claim_keys() {
            for offset in [None, Some(-300_i64), Some(10)] {
                let mut claims = payload();
                if let Some(offset) = offset {
                    let time = jsonwebtoken::get_current_timestamp()
                        .checked_add_signed(offset)
                        .unwrap();
                    claims["nbf"] = json!(time);
                    claims["iat"] = json!(time);
                }
                claims["iss"] = json!("external-issuer");
                claims["aud"] = json!(["external-audience"]);
                let token = keys.sign(&claims).unwrap();
                assert!(keys.verify(&token).is_ok());
                assert_eq!(keys.verify_payload(&token).unwrap(), claims);
            }
        }
    }

    #[test]
    fn optional_time_claim_leeway_has_an_exact_inclusive_boundary() {
        for name in ["nbf", "iat"] {
            for (timestamp, accepted) in [(1_030, true), (1_031, false), (u64::MAX, false)] {
                let mut claims = payload();
                claims[name] = json!(timestamp);
                assert_eq!(validate_time_claims(&claims, 1_000).is_ok(), accepted);
            }
        }
    }
}
