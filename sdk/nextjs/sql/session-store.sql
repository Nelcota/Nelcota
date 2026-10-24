-- Application-owned, private session storage. Never an internal Nelcota migration.
-- Run as its dedicated owner; grant a dedicated app role only this schema/table.
-- Require durable commits and direct/session pooling (not transaction pooling).
BEGIN;
CREATE SCHEMA IF NOT EXISTS nelcota_next;
REVOKE ALL ON SCHEMA nelcota_next FROM PUBLIC;
CREATE TABLE IF NOT EXISTS nelcota_next.sessions (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  sealed text NOT NULL CHECK (octet_length(sealed) <= 131072),
  expires_at bigint NOT NULL CHECK (expires_at > 0)
);
REVOKE ALL ON TABLE nelcota_next.sessions FROM PUBLIC;
CREATE INDEX IF NOT EXISTS next_sessions_expiry ON nelcota_next.sessions (expires_at);
COMMIT;
