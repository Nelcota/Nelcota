//! `KEY=value` files (the projects' `.env` and `host.env`), always 0600.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::Context;

pub struct EnvFile {
    path: PathBuf,
}

impl EnvFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        EnvFile { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> anyhow::Result<Vec<(String, String)>> {
        let text = fs::read_to_string(&self.path)
            .with_context(|| format!("could not read {}", self.path.display()))?;
        Ok(parse(&text))
    }

    /// Value of a key (empty counts as missing).
    pub fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(self
            .read()?
            .into_iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
            .filter(|v| !v.is_empty()))
    }

    /// Replaces (or appends) a key, preserving the rest of the file.
    /// Values with `$` go in single quotes (Compose does not interpolate them).
    pub fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let line = match value.contains('$') {
            true => {
                format!("{key}='{value}'")
            }
            false => {
                format!("{key}={value}")
            }
        };
        let text = self.read_or_missing()?;
        let mut found = false;
        let mut lines: Vec<String> = text
            .lines()
            .map(|l| match key_of(l) == Some(key) {
                true => {
                    found = true;
                    line.clone()
                }
                false => l.to_owned(),
            })
            .collect();
        if !found {
            lines.push(line);
        }
        write_private(&self.path, &(lines.join("\n") + "\n"))
    }

    pub fn remove(&self, key: &str) -> anyhow::Result<()> {
        let text = self.read_or_missing()?;
        let lines: Vec<&str> = text.lines().filter(|l| key_of(l) != Some(key)).collect();
        write_private(&self.path, &(lines.join("\n") + "\n"))
    }

    fn read_or_missing(&self) -> anyhow::Result<String> {
        match fs::read_to_string(&self.path) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => {
                Err(error).with_context(|| format!("could not read {}", self.path.display()))
            }
        }
    }
}

fn key_of(line: &str) -> Option<&str> {
    let line = line.trim();
    if line.starts_with('#') {
        return None;
    }
    line.split_once('=').map(|(k, _)| k.trim())
}

/// `KEY=value`, ignoring comments; single/double quotes are removed.
pub fn parse(text: &str) -> Vec<(String, String)> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| {
            let v = v.trim();
            if let Some(single) = v
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
            {
                return (k.trim().to_owned(), single.replace("'\\''", "'"));
            }
            let value = v
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .unwrap_or(v);
            (k.trim().to_owned(), value.to_owned())
        })
        .collect()
}

/// Literal Compose/systemd values supported by controller-owned patches. Reject
/// escaping instead of changing the meaning of a credential or adding a line.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn validate_literal(value: &str, max: usize) -> anyhow::Result<()> {
    if value.len() > max || value.chars().any(char::is_control) || value.contains(['\'', '\\']) {
        anyhow::bail!("invalid_configuration_value");
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn validate_environment_literal(key: &str, value: &str) -> anyhow::Result<()> {
    let max = match key {
        "NELCOTA_CORS_ALLOW_ORIGINS" => nelcota_core::config::MAX_CORS_ORIGIN_LIST_BYTES,
        _ => 8192,
    };
    validate_literal(value, max)
}

/// Replace a bounded allowlisted set of environment values, preserving unrelated
/// lines. Callers own key authorization; values are always single-quoted.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn patch_literal(
    before: &str,
    values: &std::collections::BTreeMap<String, Option<String>>,
) -> anyhow::Result<String> {
    let mut seen = std::collections::HashSet::new();
    let mut lines = Vec::new();
    for line in before.lines() {
        let key = line.split_once('=').map(|(k, _)| k.trim());
        match key.and_then(|k| values.get_key_value(k)) {
            Some((key, value)) => {
                if seen.insert(key)
                    && let Some(value) = value
                {
                    validate_environment_literal(key, value)?;
                    lines.push(format!("{key}='{value}'"));
                }
            }
            None => lines.push(line.to_owned()),
        }
    }
    for (key, value) in values {
        if !seen.contains(key)
            && let Some(value) = value
        {
            validate_environment_literal(key, value)?;
            lines.push(format!("{key}='{value}'"));
        }
    }
    let result = lines.join("\n") + "\n";
    if result.len() > 65536 {
        anyhow::bail!("configuration_too_large");
    }
    Ok(result)
}

/// Writes a file readable only by its owner (0600 on Unix).
pub fn write_private(path: &Path, content: &str) -> anyhow::Result<()> {
    crate::private_fs::write(path, content)
        .with_context(|| format!("could not write {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_contents_are_never_replaced_with_an_empty_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let file = EnvFile::new(dir.path().join(".env"));
        fs::write(file.path(), [0xff, 0xfe]).unwrap();
        assert!(file.set("A", "1").is_err());
        assert!(file.remove("A").is_err());
        assert_eq!(fs::read(file.path()).unwrap(), [0xff, 0xfe]);
    }

    #[test]
    fn reads_env_with_quotes_and_comments() {
        let env = parse("# comment\nA=1\nB='$argon2id$v=19$x'\nC=\"with space\"\n\nD=\n");
        assert_eq!(
            env,
            vec![
                ("A".into(), "1".into()),
                ("B".into(), "$argon2id$v=19$x".into()),
                ("C".into(), "with space".into()),
                ("D".into(), String::new()),
            ]
        );
    }

    #[test]
    fn set_and_remove_preserve_the_rest() {
        let dir = std::env::temp_dir().join(format!("nelcota-env-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = EnvFile::new(dir.join("test.env"));
        fs::write(file.path(), "# top\nA=1\nB=2\n").unwrap();
        file.set("B", "$hash$").unwrap();
        file.set("C", "3").unwrap();
        file.remove("A").unwrap();
        assert_eq!(
            fs::read_to_string(file.path()).unwrap(),
            "# top\nB='$hash$'\nC=3\n"
        );
        assert_eq!(file.get("B").unwrap().as_deref(), Some("$hash$"));
        fs::remove_dir_all(dir).unwrap();
    }
}
