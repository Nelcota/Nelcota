//! Host management facade: admission, durable execution and bounded operator views.
mod diagnostics;
mod effects;
mod execution;
mod live;
mod policy;
mod preflight;
mod routine;
pub(super) mod settings;
mod status;

pub(super) use diagnostics::diagnostics;
#[cfg(test)]
use effects::{Effects, changed};
pub(super) use effects::{approved_backup, backup_identity, output};
pub use execution::execute;
pub(super) use policy::{control_project, free_bytes, validate_policy};
pub(super) use preflight::blockers;
pub(super) use routine::verify_prepared;
pub(super) use status::{logs, status};

#[cfg(test)]
use execution::execute_with;
#[cfg(test)]
use policy::public_ip;
#[cfg(test)]
use status::log_metadata;
#[cfg(test)]
pub(super) mod tests;
