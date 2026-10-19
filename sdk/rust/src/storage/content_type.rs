//! Pure filename-to-content-type inference.
/// Common extensions and their MIME types, for uploads without an explicit type.
const CONTENT_TYPES: &[(&str, &str)] = &[
    ("avif", "image/avif"),
    ("css", "text/css"),
    ("csv", "text/csv"),
    ("gif", "image/gif"),
    ("gz", "application/gzip"),
    ("htm", "text/html"),
    ("html", "text/html"),
    ("ico", "image/vnd.microsoft.icon"),
    ("jpeg", "image/jpeg"),
    ("jpg", "image/jpeg"),
    ("js", "text/javascript"),
    ("json", "application/json"),
    ("md", "text/markdown"),
    ("mjs", "text/javascript"),
    ("mov", "video/quicktime"),
    ("mp3", "audio/mpeg"),
    ("mp4", "video/mp4"),
    ("ogg", "audio/ogg"),
    ("pdf", "application/pdf"),
    ("png", "image/png"),
    ("svg", "image/svg+xml"),
    ("txt", "text/plain"),
    ("wasm", "application/wasm"),
    ("wav", "audio/wav"),
    ("webm", "video/webm"),
    ("webp", "image/webp"),
    ("woff2", "font/woff2"),
    ("xml", "application/xml"),
    ("zip", "application/zip"),
];

/// The MIME type for an object name's extension (`a/b.PNG` → `image/png`),
/// or `None` for an unknown or missing extension.
pub fn guess_content_type(name: &str) -> Option<&'static str> {
    let file = name.rsplit('/').next().unwrap_or(name);
    let (stem, extension) = file.rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    let extension = extension.to_ascii_lowercase();
    CONTENT_TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, mime)| *mime)
}
