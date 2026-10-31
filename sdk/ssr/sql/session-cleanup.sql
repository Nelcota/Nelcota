-- Bounded housekeeping for nelcota_next.sessions. Not a migration: schedule it
-- (cron, pg_cron, a worker) as the dedicated session role, e.g. every few minutes,
-- and repeat while it deletes a full batch. It removes expired session rows,
-- tombstones and lineage heads alike; each carries its own expires_at, and a
-- live head is refreshed whenever its lineage publishes a new identity.
-- Uses the next_sessions_expiry index; record only the deleted count.
DELETE FROM nelcota_next.sessions WHERE key IN (
  SELECT key FROM nelcota_next.sessions
  WHERE expires_at <= floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
  ORDER BY expires_at
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
);
