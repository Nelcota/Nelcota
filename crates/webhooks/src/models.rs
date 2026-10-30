//! Feature data. Keys and jobs deliberately have no Debug/Serialize impl.
use nelcota_core::config::Secret;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EndpointInput {
    pub name: String,
    pub table: String,
    pub url: String,
    pub events: Vec<String>,
    pub enabled: bool,
    pub max_attempts: i32,
}

#[derive(Serialize)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    pub schema: String,
    pub table: String,
    pub table_available: bool,
    pub url: String,
    pub events: Vec<String>,
    pub enabled: bool,
    pub max_attempts: i32,
    pub created_at: String,
}

pub struct NewSecret {
    pub endpoint: Endpoint,
    pub secret: Secret,
}

#[derive(Serialize)]
pub struct Delivery {
    pub id: String,
    pub endpoint_id: String,
    pub endpoint_name: String,
    pub endpoint_enabled: bool,
    pub event_id: String,
    pub replay_of: Option<String>,
    pub schema: String,
    pub table: String,
    pub event: String,
    pub url: String,
    pub status: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub created_at: String,
    pub next_attempt_at: Option<String>,
    pub finished_at: Option<String>,
    pub last_status: Option<i32>,
    pub last_error: Option<String>,
}

#[derive(Serialize)]
pub struct Attempt {
    pub number: i32,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status_code: Option<i32>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct DeliveryDetail {
    pub delivery: Delivery,
    pub payload: String,
    pub attempts: Vec<Attempt>,
}

pub struct DeliveryPage {
    pub deliveries: Vec<Delivery>,
    pub next_cursor: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    pub endpoint: Option<String>,
    pub status: Option<String>,
    pub before: Option<String>,
}

pub(crate) struct Job {
    pub id: i64,
    pub event_id: uuid::Uuid,
    pub attempt: i32,
    pub lease: uuid::Uuid,
    pub url: String,
    pub payload: String,
    pub secret: Secret,
}

pub(crate) struct Outcome {
    pub status: Option<i32>,
    pub error: Option<&'static str>,
    pub retryable: bool,
    pub retry_after: Option<u64>,
    pub duration_ms: i64,
    /// Nothing was sent: requeue shortly without using an attempt.
    pub deferred: bool,
}
