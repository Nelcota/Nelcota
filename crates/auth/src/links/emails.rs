//! Link rendering uses the same bounded policy as startup and panel previews.
use super::LinkKind;
use crate::Email;
use nelcota_core::email::{Language, Settings};

/// Tokens remain in the fragment and never enter subject headers or diagnostics.
pub(super) fn compose(
    kind: LinkKind,
    to: &str,
    page_url: &str,
    token: &str,
    settings: &Settings,
) -> Result<Email, nelcota_core::email::Error> {
    let link = format!("{page_url}#type={}&token={token}", kind.as_str());
    let rendered = settings.render(kind, to, &link)?;
    Ok(Email {
        to: to.to_owned(),
        subject: rendered.subject,
        text: rendered.text,
    })
}

pub(super) fn signup_notice(to: &str, language: Language) -> Email {
    let (subject, text) = match language {
        Language::English => (
            "Your account already exists",
            format!(
                "Someone tried to create an account with the email {to}, which already has one.\n\nIf it was you, sign in instead. If you forgot your password, reset it from the sign-in page.\n\nIf this was not you, ignore this email: your account has not changed.\n"
            ),
        ),
        Language::Portuguese => (
            "Sua conta já existe",
            format!(
                "Alguém tentou criar uma conta com o email {to}, que já tem uma.\n\nSe foi você, entre na conta. Se esqueceu a senha, redefina-a na página de acesso.\n\nSe não foi você, ignore este email: sua conta não foi alterada.\n"
            ),
        ),
    };
    Email {
        to: to.to_owned(),
        subject: subject.into(),
        text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links_and_reported_lifetimes_share_the_policy() {
        let mut settings = Settings::default();
        settings.recovery.ttl_minutes = 10;
        settings.recovery.subject = Some("{{project_name}} · {{validity}}".into());
        for kind in [LinkKind::Recovery, LinkKind::Signup, LinkKind::MagicLink] {
            let email = compose(
                kind,
                "ana@example.test",
                "https://app.example.test/receive",
                "opaque",
                &settings,
            )
            .unwrap();
            assert!(
                email
                    .text
                    .contains(&format!("#type={}&token=opaque", kind.as_str()))
            );
            assert!(!email.subject.contains("opaque"));
            assert!(!format!("{email:?}").contains("opaque"));
            assert!(email.text.contains("ana@example.test"));
        }
        let email = compose(
            LinkKind::Recovery,
            "ana@example.test",
            "https://app.example.test/receive",
            "opaque",
            &settings,
        )
        .unwrap();
        assert_eq!(email.subject, "Nelcota · 10 minutes");
        assert!(email.text.contains("valid for 10 minutes"));
    }
    #[test]
    fn notices_have_no_link_in_both_languages() {
        for language in [Language::English, Language::Portuguese] {
            let email = signup_notice("ana@example.test", language);
            assert!(email.text.contains("ana@example.test"));
            assert!(!email.text.contains("http"));
        }
    }
}
