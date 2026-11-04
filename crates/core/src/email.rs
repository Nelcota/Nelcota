//! Bounded plain-text auth email policy, shared by startup, controller and preview.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

mod templates;
#[cfg(test)]
mod tests;

pub const MAX_SUBJECT_BYTES: usize = 200;
pub const MAX_TEXT_BYTES: usize = 2048;
pub const MAX_RENDERED_BYTES: usize = 16384;
pub const MAX_RENDERED_SUBJECT_BYTES: usize = 512;
pub const MAX_PROJECT_BYTES: usize = 120;
pub const MAX_PAGE_BYTES: usize = 2048;

/// Bound the link before token issuance; reject credentials and ambiguous pages.
pub fn validate_link_page(page: &str) -> Result<(), Error> {
    if page.len() > MAX_PAGE_BYTES || page.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(Error);
    }
    let url = url::Url::parse(page).map_err(|_| Error)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Recovery,
    Signup,
    #[serde(rename = "magiclink")]
    MagicLink,
}
impl Kind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "recovery" => Some(Self::Recovery),
            "signup" => Some(Self::Signup),
            "magiclink" => Some(Self::MagicLink),
            _ => None,
        }
    }
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Recovery => "recovery",
            Self::Signup => "signup",
            Self::MagicLink => "magiclink",
        }
    }
    pub const fn default_minutes(self) -> u32 {
        match self {
            Self::Recovery => 60,
            Self::Signup => 1440,
            Self::MagicLink => 15,
        }
    }
    pub const fn bounds(self) -> (u32, u32) {
        match self {
            Self::Recovery => (5, 1440),
            Self::Signup => (5, 10080),
            Self::MagicLink => (1, 60),
        }
    }
    pub const fn only_unconfirmed(self) -> bool {
        matches!(self, Self::Signup)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Language {
    #[default]
    English,
    Portuguese,
}
impl Language {
    pub fn parse(value: &str) -> Result<Self, Error> {
        match value {
            "en" => Ok(Self::English),
            "pt-BR" => Ok(Self::Portuguese),
            _ => Err(Error),
        }
    }
}

/// Errors deliberately contain neither user content nor private configuration.
#[derive(Clone, Copy, Debug, thiserror::Error)]
#[error("invalid_email_content_or_lifetime")]
pub struct Error;

#[derive(Clone)]
pub struct Template {
    pub subject: Option<String>,
    pub text: Option<String>,
    pub ttl_minutes: u32,
}
impl Template {
    fn defaults(kind: Kind) -> Self {
        Self {
            subject: None,
            text: None,
            ttl_minutes: kind.default_minutes(),
        }
    }
}

#[derive(Clone)]
pub struct Settings {
    pub language: Language,
    pub project_name: String,
    pub recovery: Template,
    pub signup: Template,
    pub magic_link: Template,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            language: Language::English,
            project_name: "Nelcota".into(),
            recovery: Template::defaults(Kind::Recovery),
            signup: Template::defaults(Kind::Signup),
            magic_link: Template::defaults(Kind::MagicLink),
        }
    }
}

pub struct Rendered {
    pub subject: String,
    pub text: String,
}

impl Settings {
    pub fn from_config(config: &crate::Config) -> Result<Self, Error> {
        let value = Self {
            language: Language::parse(&config.email_language)?,
            project_name: config
                .project_name
                .clone()
                .unwrap_or_else(|| "Nelcota".into()),
            recovery: Template {
                subject: decode(config.email_recovery_subject_base64.as_deref())?,
                text: decode(config.email_recovery_text_base64.as_deref())?,
                ttl_minutes: config.email_recovery_ttl_minutes,
            },
            signup: Template {
                subject: decode(config.email_signup_subject_base64.as_deref())?,
                text: decode(config.email_signup_text_base64.as_deref())?,
                ttl_minutes: config.email_signup_ttl_minutes,
            },
            magic_link: Template {
                subject: decode(config.email_magiclink_subject_base64.as_deref())?,
                text: decode(config.email_magiclink_text_base64.as_deref())?,
                ttl_minutes: config.email_magiclink_ttl_minutes,
            },
        };
        value.validate()?;
        Ok(value)
    }

    pub fn template(&self, kind: Kind) -> &Template {
        match kind {
            Kind::Recovery => &self.recovery,
            Kind::Signup => &self.signup,
            Kind::MagicLink => &self.magic_link,
        }
    }
    pub fn template_mut(&mut self, kind: Kind) -> &mut Template {
        match kind {
            Kind::Recovery => &mut self.recovery,
            Kind::Signup => &mut self.signup,
            Kind::MagicLink => &mut self.magic_link,
        }
    }
    pub fn content(&self, kind: Kind) -> (&str, &str) {
        let defaults = templates::defaults(self.language, kind);
        let selected = self.template(kind);
        (
            selected.subject.as_deref().unwrap_or(defaults.0),
            selected.text.as_deref().unwrap_or(defaults.1),
        )
    }
    pub fn validate(&self) -> Result<(), Error> {
        if !single_line(&self.project_name, MAX_PROJECT_BYTES) {
            return Err(Error);
        }
        for kind in [Kind::Recovery, Kind::Signup, Kind::MagicLink] {
            let (minimum, maximum) = kind.bounds();
            if !(minimum..=maximum).contains(&self.template(kind).ttl_minutes) {
                return Err(Error);
            }
            let (subject, text) = self.content(kind);
            templates::validate(subject, text)?;
        }
        Ok(())
    }

    /// Render once: substituted values can never introduce another placeholder.
    pub fn render(&self, kind: Kind, to: &str, link: &str) -> Result<Rendered, Error> {
        self.validate()?;
        if !single_line(to, 320) || !single_line(link, 4096) {
            return Err(Error);
        }
        let (subject, text) = self.content(kind);
        let validity = templates::validity(self.language, self.template(kind).ttl_minutes);
        let values = templates::Values {
            project_name: &self.project_name,
            email: to,
            link,
            validity: &validity,
        };
        Ok(Rendered {
            subject: templates::render_subject(subject, &values)?,
            text: templates::render_text(text, &values)?,
        })
    }

    /// Default-selected text for the allowlisted runtime catalog, never raw config.
    pub fn catalog_value(&self, key: &str) -> Option<String> {
        let (kind, subject) = match key {
            "email_recovery_subject_base64" => (Kind::Recovery, true),
            "email_recovery_text_base64" => (Kind::Recovery, false),
            "email_signup_subject_base64" => (Kind::Signup, true),
            "email_signup_text_base64" => (Kind::Signup, false),
            "email_magiclink_subject_base64" => (Kind::MagicLink, true),
            "email_magiclink_text_base64" => (Kind::MagicLink, false),
            _ => return None,
        };
        let content = self.content(kind);
        Some(
            match subject {
                true => content.0,
                false => content.1,
            }
            .to_owned(),
        )
    }
}

/// Private environment persistence is explicit RFC 4648 base64, not shell escapes.
pub fn encode(value: &str) -> String {
    STANDARD.encode(value)
}
pub fn decode(value: Option<&str>) -> Result<Option<String>, Error> {
    let value = match value {
        Some(value) => value,
        None => return Ok(None),
    };
    if value.len() > MAX_TEXT_BYTES.div_ceil(3) * 4 {
        return Err(Error);
    }
    let decoded = STANDARD.decode(value).map_err(|_| Error)?;
    if decoded.len() > MAX_TEXT_BYTES {
        return Err(Error);
    }
    String::from_utf8(decoded).map(Some).map_err(|_| Error)
}
pub(super) fn single_line(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
}
