//! Limits of the controller contracts, shared by the Rust checks and, with the
//! `schema` feature, by the JSON Schema the panel validates replies with (D83).
//! Fields marked `#[schemars(skip_serializing_if)]` are always sent, but the
//! panel also accepts them missing, so their schema leaves them optional.
// Without the feature only the limits the Rust checks share are used.
#![cfg_attr(not(feature = "schema"), allow(dead_code))]

/// What `valid_project` accepts: enrolled names may start or end with a hyphen.
pub(crate) const PROJECT: &str = r"^[a-z0-9-]{1,32}$";
/// What `Operation::validate` accepts: no leading or trailing hyphen.
pub(crate) const OPERATION_PROJECT: &str = r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$";
/// A project name, or empty when none is chosen.
pub(crate) const OPTIONAL_PROJECT: &str = r"^[a-z0-9-]{0,32}$";
pub(crate) const DIGEST: &str = r"^[a-f0-9]{64}$";
/// Lowercase DNS name with at least two labels (no IP literals, URLs or wildcards).
pub(crate) const DOMAIN: &str =
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$";
pub(crate) const BACKUP: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._-]*\.dump$";
pub(crate) const NO_CONTROL: &str = r"^[^\u0000-\u001f]*$";
pub(crate) const HOST_NAME: &str = r"^[a-z0-9.-]+$";
pub(crate) const INCIDENT_KEY: &str = r"^(?:host\.(?:disk|monitoring)|[a-f0-9]{64}\.[a-z_]{1,20})$";
pub(crate) const CHECK_NAME: &str = r"^[a-z_]{1,40}$";

/// Free text the panel displays.
pub(crate) const TEXT_MAX: usize = 1024;
pub(crate) const DOMAIN_MAX: usize = 253;
pub(crate) const HOST_NAME_MAX: usize = 253;
pub(crate) const EMAIL_MAX: usize = 254;
pub(crate) const BACKUP_NAME_MAX: usize = 200;
/// Projects on a host, and so also jobs, affected projects and backups listed per project.
pub(crate) const MAX_PROJECTS: usize = 32;
pub(crate) const MAX_JOBS: usize = 32;
pub(crate) const MAX_BACKUPS: usize = 32;
pub(crate) const MAX_BLOCKERS: usize = 32;
pub(crate) const MAX_CHECKS: usize = 32;
pub(crate) const MAX_RECIPIENTS: usize = 16;
/// One email and one webhook channel.
pub(crate) const MAX_CHANNELS: usize = 2;
/// Unix seconds up to the end of the JavaScript Date range.
pub(crate) const TIME_MAX: u64 = 8_640_000_000_000;

#[cfg(feature = "schema")]
pub(crate) fn is_false(value: &bool) -> bool {
    !*value
}
