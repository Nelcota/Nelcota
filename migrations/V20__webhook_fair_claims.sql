-- Fair claims: each round takes the oldest due delivery of every webhook with
-- free in-flight capacity, so one slow destination cannot hold every slot.
CREATE INDEX webhook_deliveries_endpoint_due ON nelcota.webhook_deliveries (endpoint_id, next_attempt_at, id)
    WHERE status = 'pending';
CREATE INDEX webhook_deliveries_inflight ON nelcota.webhook_deliveries (endpoint_id, locked_until)
    WHERE status = 'processing';
-- A send that never left this host (local DNS capacity exhausted) gives its
-- attempt back: the worker removes the attempt it had started.
GRANT DELETE ON nelcota.webhook_attempts TO nelcota_webhooks;
-- Consecutive sends deferred that way. Past the limit the next deferral uses an
-- attempt, so a resolver that never answers cannot postpone a delivery forever.
ALTER TABLE nelcota.webhook_deliveries ADD COLUMN deferrals integer NOT NULL DEFAULT 0;
