//! Real Postgres and HTTP receivers exercise the complete event delivery path.
#[path = "webhooks/boundaries.rs"]
mod boundaries;
#[path = "webhooks/capture.rs"]
mod capture;
mod common;
#[path = "webhooks/configuration.rs"]
mod configuration;
#[path = "webhooks/delivery.rs"]
mod delivery;
#[path = "webhooks/support.rs"]
mod support;
