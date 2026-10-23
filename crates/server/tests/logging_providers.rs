//! Synthetic provider messages must not become application diagnostics.
#[path = "logging_providers/cases.rs"]
mod cases;
mod common;

#[tokio::test]
async fn opaque_provider_failures_keep_context_without_external_message_values() {
    cases::check_provider_diagnostics(false).await;
}
