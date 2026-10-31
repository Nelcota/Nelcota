-- Application-owned, private session storage. Never an internal Nelcota migration.
-- Run as its dedicated owner; grant a dedicated app role only this schema/table.
-- Require durable commits and direct/session pooling (not transaction pooling).
-- Frozen: the nelcota_next schema/table names and these CHECKs are deployed wire
-- format shared with @nelcota/nextjs 0.1.x. The 131072-byte CHECK is an outer
-- bound; the adapter writes at most MAX_SEALED_CHARS (about 87 KB, derived from
-- the 64 KiB plaintext cap). Expired rows: see session-cleanup.sql.
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
