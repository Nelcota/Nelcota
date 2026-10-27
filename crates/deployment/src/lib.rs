//! Deployment contracts are independent of HTTP, databases and runtime adapters.
mod journal;
mod release;
mod secure_fs;

pub use journal::{HostLock, Job, Journal, Phase, PublicJob};
pub use release::{Artifact, PROTOCOL_VERSION, Release, valid_digest, valid_project};
pub use secure_fs::{atomic_write, digest_file, private_dir, read_private, token};

#[cfg(test)]
mod tests;

pub mod management;
pub mod operations;
pub mod protocol;

pub mod alerts;
mod schema;
