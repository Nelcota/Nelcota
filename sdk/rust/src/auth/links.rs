//! OAuth and email-link values with credential-redacting Debug implementations.
use std::collections::BTreeMap;
use url::Url;

#[derive(Clone, Copy, Debug)]
pub enum OAuthProvider {
    Google,
    Github,
}
impl OAuthProvider {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Github => "github",
        }
    }
}

pub struct PkceFlow {
    pub url: Url,
    pub verifier: String,
}
impl std::fmt::Debug for PkceFlow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PkceFlow")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmailLinkType {
    Signup,
    MagicLink,
    Recovery,
}
impl EmailLinkType {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Signup => "signup",
            Self::MagicLink => "magiclink",
            Self::Recovery => "recovery",
        }
    }
}
pub struct EmailLink {
    pub kind: EmailLinkType,
    pub token: String,
}
impl std::fmt::Debug for EmailLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmailLink")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}
impl EmailLink {
    pub fn parse(url: &mut Url) -> Option<Self> {
        let fragment = url.fragment()?;
        let pairs: BTreeMap<_, _> = url::form_urlencoded::parse(fragment.as_bytes())
            .into_owned()
            .collect();
        let kind = match pairs.get("type")?.as_str() {
            "signup" => EmailLinkType::Signup,
            "magiclink" => EmailLinkType::MagicLink,
            "recovery" => EmailLinkType::Recovery,
            _ => return None,
        };
        let token = pairs.get("token")?.clone();
        if token.is_empty() || token.len() > 128 {
            return None;
        }
        url.set_fragment(None);
        Some(Self { kind, token })
    }
}
