use super::*;

#[test]
fn link_pages_are_bounded_before_any_token_is_issued() {
    for page in [
        "javascript:alert(1)".to_owned(),
        "https://user:private@example.test".into(),
        "https://example.test/#existing".into(),
        "https://example.test/with space".into(),
        format!("https://example.test/{}", "x".repeat(MAX_PAGE_BYTES)),
    ] {
        assert!(validate_link_page(&page).is_err());
        let config = crate::Config {
            smtp_url: Some(crate::Secret::new("smtps://smtp.example.test")),
            smtp_from: Some("sender@example.test".into()),
            password_recovery_url: Some(page),
            ..Default::default()
        };
        let error = config.mail().err().unwrap().to_string();
        assert!(!error.contains("private"));
    }
    assert!(validate_link_page("https://example.test/reset?source=email").is_ok());
    assert!(validate_link_page("http://localhost:3000/reset").is_ok());
}

#[test]
fn defaults_preserve_english_content_and_localize_all_flows() {
    let mut settings = Settings::default();
    let message = settings
        .render(
            Kind::Recovery,
            "ana@example.test",
            "https://app.example.test/#type=recovery&token=opaque",
        )
        .unwrap();
    assert_eq!(message.subject, "Reset your password");
    assert!(message.text.contains("valid for 1 hour"));
    for kind in [Kind::Recovery, Kind::Signup, Kind::MagicLink] {
        settings.language = Language::Portuguese;
        let message = settings
            .render(
                kind,
                "ana@example.test",
                "https://example.test/#token=opaque",
            )
            .unwrap();
        assert!(message.text.contains("só pode ser usado uma vez"));
        assert!(message.text.contains("ana@example.test"));
        assert!(!message.text.contains("{{"));
    }
}

#[test]
fn multiline_unicode_and_shell_metacharacters_roundtrip_explicitly() {
    let text = "Olá {{email}}!\n\nD'água, $HOME, \\ e # são texto literal.\n{{link}}\n{{project_name}} · {{validity}}";
    let config = crate::Config {
        email_recovery_text_base64: Some(encode(text)),
        ..Default::default()
    };
    let settings = Settings::from_config(&config).unwrap();
    assert_eq!(settings.content(Kind::Recovery).1, text);
    assert_eq!(decode(Some(&encode(text))).unwrap().as_deref(), Some(text));
    for value in [
        "not base64!".to_owned(),
        "x".repeat(10000),
        STANDARD.encode([0xff]),
    ] {
        assert!(decode(Some(&value)).is_err());
    }
}

#[test]
fn unsafe_headers_placeholders_controls_and_missing_links_are_rejected() {
    for subject in [
        "x\r\nBcc: victim@example.test",
        "x\n",
        "x\u{2028}y",
        "{{link}}",
        "{{email}}",
        "{{secret}}",
        "{{project_name",
        "x}}",
    ] {
        let mut settings = Settings::default();
        settings.recovery.subject = Some(subject.into());
        assert!(settings.validate().is_err(), "{subject:?}");
    }
    for text in [
        "no link",
        "{{link}}{{link}}",
        "{{token}} {{link}}",
        "{{link}}\0",
        "{{link}}\r\n",
        "{{{{link}}",
        "{{link}} }}",
    ] {
        let mut settings = Settings::default();
        settings.recovery.text = Some(text.into());
        assert!(settings.validate().is_err(), "{text:?}");
    }
    let mut settings = Settings::default();
    settings.recovery.text = Some(format!("{}{{{{link}}}}", "{{email}}".repeat(100)));
    assert!(
        settings.validate().is_err(),
        "worst-case output budget must be checked"
    );
    settings = Settings::default();
    settings.project_name = "name\r\nInjected: value".into();
    assert!(settings.validate().is_err());
}

#[test]
fn substitutions_are_not_recursively_expanded_and_lifetimes_are_bounded() {
    let mut settings = Settings {
        project_name: "{{link}}".into(),
        ..Default::default()
    };
    settings.recovery.text = Some("{{project_name}}\n{{link}}".into());
    let message = settings
        .render(
            Kind::Recovery,
            "ana@example.test",
            "https://example.test/preview",
        )
        .unwrap();
    assert_eq!(message.text, "{{link}}\nhttps://example.test/preview");
    for kind in [Kind::Recovery, Kind::Signup, Kind::MagicLink] {
        let (minimum, maximum) = kind.bounds();
        for value in [minimum, maximum] {
            settings.template_mut(kind).ttl_minutes = value;
            assert!(settings.validate().is_ok());
        }
        for value in [0, maximum + 1, u32::MAX] {
            settings.template_mut(kind).ttl_minutes = value;
            assert!(settings.validate().is_err());
        }
        settings.template_mut(kind).ttl_minutes = kind.default_minutes();
    }
}
