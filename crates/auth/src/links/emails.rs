//! Text of the link emails.
use super::LinkKind;
use crate::Email;

/// Email carrying a link to `page_url`. The token goes in the fragment: the
/// browser does not send it to the app's server, so it never shows in logs or
/// the `Referer`.
pub(super) fn compose(kind: LinkKind, to: &str, page_url: &str, token: &str) -> Email {
    let link = format!("{page_url}#type={}&token={token}", kind.as_str());
    let validity = describe_minutes(kind.ttl_minutes());
    let (subject, text) = match kind {
        LinkKind::Recovery => (
            "Reset your password",
            format!(
                "We received a request to reset the password of the account {to}.\n\n\
                 To choose a new password, open the link below. It is valid for {validity} \
                 and can be used only once:\n\n{link}\n\n\
                 If this was not you, ignore this email: your password stays the same.\n"
            ),
        ),
        LinkKind::Signup => (
            "Confirm your email",
            format!(
                "Someone created an account with the email {to}.\n\n\
                 To confirm it, open the link below. It is valid for {validity} \
                 and can be used only once:\n\n{link}\n\n\
                 If this was not you, ignore this email: the account stays unconfirmed.\n"
            ),
        ),
        LinkKind::MagicLink => (
            "Your sign-in link",
            format!(
                "We received a request to sign in to the account {to}.\n\n\
                 To sign in, open the link below. It is valid for {validity} \
                 and can be used only once:\n\n{link}\n\n\
                 If this was not you, ignore this email: nobody signs in without the link.\n"
            ),
        ),
    };
    Email {
        to: to.to_owned(),
        subject: subject.into(),
        text,
    }
}

/// Email telling the owner of an existing account that someone tried to sign
/// up with its address. Signup answers that attempt like a new one, so this
/// email is the only place where the account's existence shows.
pub(super) fn signup_notice(to: &str) -> Email {
    Email {
        to: to.to_owned(),
        subject: "Your account already exists".into(),
        text: format!(
            "Someone tried to create an account with the email {to}, \
             which already has one.\n\n\
             If it was you, sign in instead. If you forgot your password, \
             reset it from the sign-in page.\n\n\
             If this was not you, ignore this email: your account has not changed.\n"
        ),
    }
}

fn describe_minutes(minutes: i32) -> String {
    match minutes {
        60 => "1 hour".into(),
        m if m % 60 == 0 => format!("{} hours", m / 60),
        m => format!("{m} minutes"),
    }
}

#[cfg(test)]
mod tests {
    use super::{LinkKind, compose, describe_minutes, signup_notice};

    #[test]
    fn link_carries_its_kind_and_token_in_the_fragment() {
        let email = compose(
            LinkKind::Recovery,
            "ana@x.com",
            "https://app.x.com/new-password",
            "abc_-123",
        );
        assert_eq!(email.to, "ana@x.com");
        assert!(
            email
                .text
                .contains("https://app.x.com/new-password#type=recovery&token=abc_-123")
        );
        assert!(email.text.contains("ana@x.com"));
        assert!(email.text.contains("valid for 1 hour"));

        let email = compose(
            LinkKind::MagicLink,
            "ana@x.com",
            "https://app.x.com/in",
            "t",
        );
        assert!(
            email
                .text
                .contains("https://app.x.com/in#type=magiclink&token=t")
        );
        assert!(email.text.contains("valid for 15 minutes"));

        let email = compose(LinkKind::Signup, "ana@x.com", "https://app.x.com/ok", "t");
        assert!(
            email
                .text
                .contains("https://app.x.com/ok#type=signup&token=t")
        );
        assert!(email.text.contains("valid for 24 hours"));
    }

    #[test]
    fn signup_notice_names_the_account_and_carries_no_link() {
        let email = signup_notice("ana@x.com");
        assert_eq!(email.to, "ana@x.com");
        assert_eq!(email.subject, "Your account already exists");
        assert!(email.text.contains("ana@x.com"));
        assert!(!email.text.contains("http"), "{}", email.text);
    }

    #[test]
    fn durations_read_naturally() {
        assert_eq!(describe_minutes(15), "15 minutes");
        assert_eq!(describe_minutes(60), "1 hour");
        assert_eq!(describe_minutes(1440), "24 hours");
    }
}
