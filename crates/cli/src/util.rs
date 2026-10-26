//! Small utilities: random secrets, dates, prompts, healthcheck.

use std::{
    io::{BufRead, IsTerminal, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const ALPHANUMERIC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// Alphanumeric secret (safe for URLs and `.env`), without modulo bias.
pub fn secret(len: usize) -> String {
    let mut out = String::with_capacity(len);
    let mut buf = [0u8; 64];
    while out.len() < len {
        getrandom::fill(&mut buf).expect("system randomness source unavailable");
        for b in buf {
            // 248 = 62 * 4: discard the remainder so the distribution stays uniform.
            if b < 248 && out.len() < len {
                out.push(ALPHANUMERIC[usize::from(b) % ALPHANUMERIC.len()] as char);
            }
        }
    }
    out
}

/// Current UTC date/time as `YYYYMMDDTHHMMSSZ`.
pub fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    format_timestamp(secs)
}

/// Last second of the year 9999, the end of four-digit years.
const LAST_FOUR_DIGIT_YEAR_SECOND: u64 = 253_402_300_799;

fn format_timestamp(secs: u64) -> String {
    // Clamp to 9999-12-31T23:59:59Z: a broken clock must not panic a request.
    let clamped = secs.min(LAST_FOUR_DIGIT_YEAR_SECOND);
    let at = i64::try_from(clamped)
        .ok()
        .and_then(|secs| time::OffsetDateTime::from_unix_timestamp(secs).ok())
        .expect("clamped seconds fit an OffsetDateTime");
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

/// How long ago `time` was, e.g. `45m`, `5h`, `3d`.
pub fn age(time: SystemTime) -> String {
    format_age(SystemTime::now().duration_since(time).unwrap_or_default())
}

fn format_age(age: Duration) -> String {
    let secs = age.as_secs();
    match secs {
        0..3600 => format!("{}m", secs / 60),
        3600..172_800 => format!("{}h", secs / 3600),
        _ => format!("{}d", secs / 86_400),
    }
}

pub fn interactive() -> bool {
    std::io::stdin().is_terminal()
}

/// Question with a default value (Enter accepts the default).
pub fn ask(question: &str, default: &str) -> String {
    match default.is_empty() {
        true => {
            print!("{question}: ");
        }
        false => {
            print!("{question} [{default}]: ");
        }
    }
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
    let line = line.trim();
    if line.is_empty() {
        return default.to_owned();
    }
    line.to_owned()
}

/// Question whose answer is not echoed (a secret). Without a terminal on stdin
/// it falls back to [`ask`].
#[cfg(unix)]
pub fn ask_secret(question: &str) -> String {
    let Some(_echo) = EchoOff::new() else {
        return ask(question, "");
    };
    let answer = ask(question, "");
    println!();
    answer
}

#[cfg(not(unix))]
pub fn ask_secret(question: &str) -> String {
    ask(question, "")
}

/// Turns stdin echo off and restores the previous terminal mode on drop, so a
/// panic while reading does not leave the terminal silent.
#[cfg(unix)]
struct EchoOff(rustix::termios::Termios);

#[cfg(unix)]
impl EchoOff {
    fn new() -> Option<Self> {
        use rustix::termios::{LocalModes, OptionalActions, tcgetattr, tcsetattr};
        let stdin = std::io::stdin();
        let previous = tcgetattr(&stdin).ok()?;
        let mut silent = previous.clone();
        silent.local_modes.remove(LocalModes::ECHO);
        tcsetattr(&stdin, OptionalActions::Now, &silent).ok()?;
        Some(Self(previous))
    }
}

#[cfg(unix)]
impl Drop for EchoOff {
    fn drop(&mut self) {
        use rustix::termios::{OptionalActions, tcsetattr};
        if let Err(error) = tcsetattr(std::io::stdin(), OptionalActions::Now, &self.0) {
            eprintln!("could not restore terminal echo ({error}); run `stty echo`");
        }
    }
}

pub fn confirm(question: &str) -> bool {
    matches!(
        ask(&format!("{question} (y/N)"), "")
            .to_lowercase()
            .as_str(),
        "y" | "yes"
    )
}

/// GET /health over plain TCP (the image is `scratch`, no curl).
pub fn healthcheck(addr: &str) -> bool {
    http_ok(addr, "/health")
}
pub(crate) fn deployment_ready(addr: &str) -> bool {
    http_ok(addr, "/admin/api/whoami")
}
fn http_ok(addr: &str, path: &str) -> bool {
    let socket = match addr.to_socket_addrs().ok().and_then(|mut a| a.next()) {
        Some(socket) => socket,
        _ => {
            return false;
        }
    };
    let mut stream = match TcpStream::connect_timeout(&socket, Duration::from_secs(2)) {
        Ok(stream) => stream,
        _ => {
            return false;
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0u8; 16];
    let mut read = 0;
    while read < response.len() {
        match stream.read(&mut response[read..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => read += n,
        }
    }
    response[..read].starts_with(b"HTTP/1.1 200")
}

pub fn step(message: &str) {
    println!("→ {message}");
}

pub fn ok(message: &str) {
    println!("  ✓ {message}");
}

pub fn warn(message: &str) {
    println!("  ! {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alphanumeric_secret_of_the_requested_length() {
        let s = secret(40);
        assert_eq!(s.len(), 40);
        assert!(s.bytes().all(|b| b.is_ascii_alphanumeric()));
        assert_ne!(secret(40), s);
    }

    #[test]
    fn formats_ages() {
        assert_eq!(format_age(Duration::from_secs(59)), "0m");
        assert_eq!(format_age(Duration::from_secs(45 * 60)), "45m");
        assert_eq!(format_age(Duration::from_secs(5 * 3600 + 10)), "5h");
        assert_eq!(format_age(Duration::from_secs(47 * 3600)), "47h");
        assert_eq!(format_age(Duration::from_secs(3 * 86_400)), "3d");
    }

    #[test]
    fn formats_utc_timestamp() {
        assert_eq!(format_timestamp(0), "19700101T000000Z");
        assert_eq!(format_timestamp(1_791_308_348), "20261006T173908Z");
        assert_eq!(format_timestamp(951_782_400), "20000229T000000Z");
        assert_eq!(format_timestamp(u64::MAX), "99991231T235959Z");
    }
}
