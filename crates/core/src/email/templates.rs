use super::{
    Error, Kind, Language, MAX_PROJECT_BYTES, MAX_RENDERED_BYTES, MAX_RENDERED_SUBJECT_BYTES,
    MAX_SUBJECT_BYTES, MAX_TEXT_BYTES, single_line,
};

pub(super) fn defaults(language: Language, kind: Kind) -> (&'static str, &'static str) {
    match (language, kind) {
        (Language::English, Kind::Recovery) => (
            "Reset your password",
            "We received a request to reset the password of the account {{email}}.\n\nTo choose a new password, open the link below. It is valid for {{validity}} and can be used only once:\n\n{{link}}\n\nIf this was not you, ignore this email: your password stays the same.\n",
        ),
        (Language::English, Kind::Signup) => (
            "Confirm your email",
            "Someone created an account with the email {{email}}.\n\nTo confirm it, open the link below. It is valid for {{validity}} and can be used only once:\n\n{{link}}\n\nIf this was not you, ignore this email: the account stays unconfirmed.\n",
        ),
        (Language::English, Kind::MagicLink) => (
            "Your sign-in link",
            "We received a request to sign in to the account {{email}}.\n\nTo sign in, open the link below. It is valid for {{validity}} and can be used only once:\n\n{{link}}\n\nIf this was not you, ignore this email: nobody signs in without the link.\n",
        ),
        (Language::Portuguese, Kind::Recovery) => (
            "Redefina sua senha",
            "Recebemos uma solicitação para redefinir a senha da conta {{email}}.\n\nPara escolher uma nova senha, abra o link abaixo. Ele é válido por {{validity}} e só pode ser usado uma vez:\n\n{{link}}\n\nSe não foi você, ignore este email: sua senha permanece a mesma.\n",
        ),
        (Language::Portuguese, Kind::Signup) => (
            "Confirme seu email",
            "Uma conta foi criada com o email {{email}}.\n\nPara confirmá-la, abra o link abaixo. Ele é válido por {{validity}} e só pode ser usado uma vez:\n\n{{link}}\n\nSe não foi você, ignore este email: a conta permanece sem confirmação.\n",
        ),
        (Language::Portuguese, Kind::MagicLink) => (
            "Seu link de acesso",
            "Recebemos uma solicitação para acessar a conta {{email}}.\n\nPara entrar, abra o link abaixo. Ele é válido por {{validity}} e só pode ser usado uma vez:\n\n{{link}}\n\nSe não foi você, ignore este email: ninguém entra sem o link.\n",
        ),
    }
}

pub(super) struct Values<'a> {
    pub project_name: &'a str,
    pub email: &'a str,
    pub link: &'a str,
    pub validity: &'a str,
}

fn expand(
    template: &str,
    values: &Values<'_>,
    maximum: usize,
    subject: bool,
) -> Result<(String, usize), Error> {
    let mut remaining = template;
    let mut output = String::new();
    let mut links = 0;
    while let Some(start) = remaining.find("{{") {
        let prefix = &remaining[..start];
        if prefix.contains("}}") {
            return Err(Error);
        }
        let tail = &remaining[start + 2..];
        let end = tail.find("}}").ok_or(Error)?;
        let value = match &tail[..end] {
            "project_name" => values.project_name,
            "validity" => values.validity,
            "email" if !subject => values.email,
            "link" if !subject => {
                links += 1;
                values.link
            }
            _ => return Err(Error),
        };
        if output.len() + prefix.len() + value.len() > maximum {
            return Err(Error);
        }
        output.push_str(prefix);
        output.push_str(value);
        remaining = &tail[end + 2..];
    }
    if remaining.contains("}}") || output.len() + remaining.len() > maximum {
        return Err(Error);
    }
    output.push_str(remaining);
    Ok((output, links))
}

pub(super) fn validate(subject: &str, text: &str) -> Result<(), Error> {
    if !single_line(subject, MAX_SUBJECT_BYTES)
        || text.trim().is_empty()
        || text.len() > MAX_TEXT_BYTES
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err(Error);
    }
    // Validate the worst permitted substitutions, not only a short preview.
    let project = "x".repeat(MAX_PROJECT_BYTES);
    let email = "x".repeat(320);
    let link = "x".repeat(4096);
    let validity = "x".repeat(48);
    let values = Values {
        project_name: &project,
        email: &email,
        link: &link,
        validity: &validity,
    };
    expand(subject, &values, MAX_RENDERED_SUBJECT_BYTES, true)?;
    let (_, links) = expand(text, &values, MAX_RENDERED_BYTES, false)?;
    if links != 1 {
        return Err(Error);
    }
    Ok(())
}

pub(super) fn render_subject(template: &str, values: &Values<'_>) -> Result<String, Error> {
    expand(template, values, MAX_RENDERED_SUBJECT_BYTES, true).map(|(text, _)| text)
}
pub(super) fn render_text(template: &str, values: &Values<'_>) -> Result<String, Error> {
    expand(template, values, MAX_RENDERED_BYTES, false).map(|(text, _)| text)
}

pub(super) fn validity(language: Language, minutes: u32) -> String {
    match (language, minutes) {
        (Language::English, 60) => "1 hour".into(),
        (Language::English, m) if m % 60 == 0 => format!("{} hours", m / 60),
        (Language::English, 1) => "1 minute".into(),
        (Language::English, m) => format!("{m} minutes"),
        (Language::Portuguese, 60) => "1 hora".into(),
        (Language::Portuguese, m) if m % 60 == 0 => format!("{} horas", m / 60),
        (Language::Portuguese, 1) => "1 minuto".into(),
        (Language::Portuguese, m) => format!("{m} minutos"),
    }
}
