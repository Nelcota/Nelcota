//! Sessions, email links and native OAuth/PKCE. Session clones share one lifecycle lock.
mod client;
mod links;
mod manager;
mod models;
mod storage;

pub use client::{AuthClient, AutoRefresh};
pub use links::{EmailLink, EmailLinkType, OAuthProvider, PkceFlow};
pub(crate) use manager::Manager;
pub use models::{AuthEvent, AuthEventKind, Session, SignUp, User, UserUpdate};
pub use storage::{FileStorage, MemoryStorage, SessionStorage, StorageFuture};
