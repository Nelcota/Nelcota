//! File types (D79): sniffed from the first bytes, checked against the
//! bucket's list, and turned into how the file is served.

/// Bytes read before deciding the type.
pub const SNIFF_BYTES: usize = 8192;

const OCTET_STREAM: &str = "application/octet-stream";

/// The type stored for a file. A type recognized from the bytes wins over
/// the client's. The client's is kept only for formats the bytes cannot tell
/// (text, JSON, SVG...); a binary format the bytes contradict (says
/// `image/png`, is not a PNG) becomes `application/octet-stream`.
pub fn effective(head: &[u8], declared: Option<&str>) -> String {
    if let Some(kind) = infer::get(head) {
        return kind.mime_type().to_owned();
    }
    match declared.and_then(clean) {
        Some(declared) if declared == "image/svg+xml" && looks_like_svg(head) => declared,
        Some(declared)
            if !infer::is_mime_supported(&declared)
                && !declared.starts_with("image/")
                && !declared.starts_with("audio/")
                && !declared.starts_with("video/") =>
        {
            declared
        }
        _ => OCTET_STREAM.to_owned(),
    }
}

fn looks_like_svg(head: &[u8]) -> bool {
    let trimmed = head
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(head)
        .trim_ascii_start();
    trimmed.starts_with(b"<")
        && head
            .windows(4)
            .any(|window| window.eq_ignore_ascii_case(b"<svg"))
}

/// `type/subtype` in lowercase, without parameters (`; charset=...`).
fn clean(value: &str) -> Option<String> {
    let essence = value.split(';').next()?.trim().to_ascii_lowercase();
    let (kind, subtype) = essence.split_once('/')?;
    let token = |s: &str| {
        !s.is_empty()
            && s.len() <= 127
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&-^_.+".contains(&b))
    };
    (token(kind) && token(subtype)).then_some(essence)
}

/// Whether the bucket accepts `mime`: no list accepts anything; entries are
/// exact (`image/png`) or a family (`image/*`).
pub fn allowed(mime: &str, list: Option<&[String]>) -> bool {
    let list = match list {
        Some(list) => list,
        _ => {
            return true;
        }
    };
    list.iter().any(|entry| match entry.strip_suffix("/*") {
        Some(family) => mime
            .split_once('/')
            .is_some_and(|(kind, _)| kind.eq_ignore_ascii_case(family)),
        None => entry.eq_ignore_ascii_case(mime),
    })
}

/// Types a browser may show in the page: they cannot run scripts. HTML,
/// SVG, PDF and the rest are downloaded instead.
pub fn inline(mime: &str) -> bool {
    let media =
        (mime.starts_with("image/") || mime.starts_with("audio/") || mime.starts_with("video/"))
            && infer::is_mime_supported(mime);
    media || mime == "text/plain"
}

/// `Content-Type` header: text gets an explicit charset.
pub fn content_type(mime: &str) -> String {
    if mime.starts_with("text/") {
        return format!("{mime}; charset=utf-8");
    }
    mime.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn bytes_win_over_the_client() {
        assert_eq!(effective(PNG, Some("text/html")), "image/png");
        assert_eq!(effective(PNG, None), "image/png");
        assert_eq!(effective(b"%PDF-1.7", Some("image/png")), "application/pdf");
    }

    #[test]
    fn a_claimed_binary_type_must_match_the_bytes() {
        assert_eq!(
            effective(b"just some words", Some("image/png")),
            OCTET_STREAM
        );
        // HTML is recognized, so an `image/*` bucket refuses it.
        let html = effective(b"<html><script>alert(1)</script></html>", Some("image/png"));
        assert_eq!(html, "text/html");
        assert!(!allowed(&html, Some(&["image/*".to_owned()])));
    }

    #[test]
    fn text_formats_keep_the_declared_type() {
        assert_eq!(
            effective(b"{\"a\":1}", Some("Application/JSON; charset=utf-8")),
            "application/json"
        );
        assert_eq!(effective(b"<svg/>", Some("image/svg+xml")), "image/svg+xml");
        assert_eq!(effective(b"hello", None), OCTET_STREAM);
        assert_eq!(effective(b"hello", Some("not a type")), OCTET_STREAM);
        assert_eq!(effective(b"hello", Some("text/pla in")), OCTET_STREAM);
    }

    #[test]
    fn bucket_lists() {
        let list = vec!["image/*".to_owned(), "application/pdf".to_owned()];
        assert!(allowed("image/png", Some(&list)));
        assert!(allowed("application/pdf", Some(&list)));
        assert!(!allowed("text/html", Some(&list)));
        assert!(!allowed("imagex/png", Some(&list)));
        assert!(allowed("text/html", None));
        assert!(!allowed("text/html", Some(&[])));
    }

    #[test]
    fn only_inert_types_are_inline() {
        for mime in [
            "image/png",
            "image/webp",
            "video/mp4",
            "audio/mpeg",
            "text/plain",
        ] {
            assert!(inline(mime), "{mime}");
        }
        for mime in [
            "image/svg+xml",
            "text/html",
            "application/pdf",
            "application/xhtml+xml",
            "text/xml",
            OCTET_STREAM,
        ] {
            assert!(!inline(mime), "{mime}");
        }
    }
}
