// Contract-only host: compile the production entrypoint with lettre's native
// certificate loader so the disposable SMTP CA can be trusted for this process.
// Ordinary builds keep their bundled Mozilla roots and never load this CA.
include!("../src/main.rs");
