//! Sessions, email links and native OAuth/PKCE. Session clones share one lifecycle lock.
mod client;
mod links;
mod models;
mod storage;

pub(crate) use client::Manager;
pub use client::{AuthClient, AutoRefresh};
pub use links::{EmailLink, EmailLinkType, OAuthProvider, PkceFlow};
pub use models::{AuthEvent, AuthEventKind, Session, SignUp, User, UserUpdate};
pub use storage::{FileStorage, MemoryStorage, SessionStorage, StorageFuture};
