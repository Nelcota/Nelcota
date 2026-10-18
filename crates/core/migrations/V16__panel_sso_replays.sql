-- Internal panel handoff receipts; never exposed to API roles.
CREATE TABLE nelcota.admin_sso_replays (
    digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
    expires_at timestamptz NOT NULL
);
CREATE INDEX admin_sso_replays_expiry ON nelcota.admin_sso_replays (expires_at);
REVOKE ALL ON nelcota.admin_sso_replays FROM PUBLIC, anon, authenticated, service_role, nelcota_auth;
