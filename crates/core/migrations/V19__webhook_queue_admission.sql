-- Queue admission never aborts a business write and takes no global row lock.
-- Outstanding work is counted per endpoint in sharded rows; overflow becomes
-- a visibly failed delivery. Terminal history is bounded by worker retention.
LOCK TABLE nelcota.webhook_deliveries IN EXCLUSIVE MODE;

CREATE TABLE nelcota.webhook_queue_shards (
    endpoint_id uuid NOT NULL REFERENCES nelcota.webhook_endpoints(id),
    shard smallint NOT NULL CHECK (shard BETWEEN 0 AND 15),
    -- One shard may go negative when work leaves through another; the sum holds.
    outstanding bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (endpoint_id, shard)
);
INSERT INTO nelcota.webhook_queue_shards (endpoint_id, shard)
SELECT e.id, s FROM nelcota.webhook_endpoints e CROSS JOIN generate_series(0, 15) s;
UPDATE nelcota.webhook_queue_shards q SET outstanding = active.total
FROM (SELECT endpoint_id, count(*) AS total FROM nelcota.webhook_deliveries
    WHERE status IN ('pending','processing') GROUP BY endpoint_id) active
WHERE q.endpoint_id = active.endpoint_id AND q.shard = 0;

CREATE FUNCTION nelcota.create_webhook_queue_shards() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    INSERT INTO nelcota.webhook_queue_shards (endpoint_id, shard)
    SELECT NEW.id, s FROM generate_series(0, 15) s;
    RETURN NULL;
END $$;
CREATE TRIGGER webhook_queue_shards AFTER INSERT ON nelcota.webhook_endpoints
FOR EACH ROW EXECUTE FUNCTION nelcota.create_webhook_queue_shards();

-- Concurrent transactions take different shard rows (SKIP LOCKED), so writers,
-- the worker and other tables never queue behind one counter. A transaction
-- prefers its backend's shard and keeps reusing a row it already holds. Only
-- when every shard of an endpoint is held by another transaction does it wait.
CREATE FUNCTION nelcota.adjust_webhook_queue(target uuid, delta bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE preferred smallint := (pg_backend_pid() % 16)::smallint; chosen smallint;
BEGIN
    SELECT q.shard INTO chosen FROM nelcota.webhook_queue_shards q
    WHERE q.endpoint_id = target
    ORDER BY q.shard = preferred DESC, q.shard
    LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF chosen IS NULL THEN
        chosen := preferred;
    END IF;
    INSERT INTO nelcota.webhook_queue_shards AS q (endpoint_id, shard, outstanding)
    VALUES (target, chosen, delta)
    ON CONFLICT (endpoint_id, shard) DO UPDATE SET outstanding = q.outstanding + EXCLUDED.outstanding;
END $$;

-- Same statement triggers as V13; only pending/processing changes touch a
-- shard, so claims and history cleanup take no counter lock at all.
CREATE OR REPLACE FUNCTION nelcota.track_webhook_queue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE changed record;
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        UPDATE nelcota.webhook_queue_shards SET outstanding = 0 WHERE outstanding <> 0;
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        FOR changed IN SELECT endpoint_id, count(*) AS delta FROM new_deliveries
            WHERE status IN ('pending','processing') GROUP BY endpoint_id ORDER BY endpoint_id
        LOOP
            PERFORM nelcota.adjust_webhook_queue(changed.endpoint_id, changed.delta);
        END LOOP;
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
        FOR changed IN SELECT endpoint_id, -count(*) AS delta FROM old_deliveries
            WHERE status IN ('pending','processing') GROUP BY endpoint_id ORDER BY endpoint_id
        LOOP
            PERFORM nelcota.adjust_webhook_queue(changed.endpoint_id, changed.delta);
        END LOOP;
        RETURN NULL;
    END IF;
    FOR changed IN SELECT moved.endpoint_id, sum(moved.delta)::bigint AS delta FROM (
            SELECT endpoint_id, 1 AS delta FROM new_deliveries WHERE status IN ('pending','processing')
            UNION ALL
            SELECT endpoint_id, -1 AS delta FROM old_deliveries WHERE status IN ('pending','processing')
        ) moved
        GROUP BY moved.endpoint_id HAVING sum(moved.delta) <> 0 ORDER BY moved.endpoint_id
    LOOP
        PERFORM nelcota.adjust_webhook_queue(changed.endpoint_id, changed.delta);
    END LOOP;
    RETURN NULL;
END $$;

DROP TABLE nelcota.webhook_queue_usage;
-- Read-only compatibility view for the panel and operators.
CREATE VIEW nelcota.webhook_queue_usage AS
SELECT true AS singleton,
    (SELECT coalesce(sum(outstanding), 0) FROM nelcota.webhook_queue_shards)::bigint AS outstanding,
    (SELECT count(*) FROM nelcota.webhook_deliveries) AS retained;

-- At most 10,000 outstanding deliveries per endpoint. Beyond that the event is
-- recorded as failed with omitted contents, like an oversized payload, and the
-- business row still commits. Concurrent transactions cannot see each other's
-- uncommitted work, so the cap can be exceeded by what they add together.
CREATE OR REPLACE FUNCTION nelcota.capture_webhook_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE event_id uuid; body text; omitted text; failure text;
BEGIN
    IF NOT EXISTS (SELECT FROM nelcota.webhook_endpoints
        WHERE table_oid = TG_RELID AND enabled AND deleted_at IS NULL AND TG_OP = ANY(events)) THEN
        RETURN NULL;
    END IF;
    event_id := gen_random_uuid();
    body := jsonb_build_object(
        'version', 1, 'id', event_id, 'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME,
        'type', TG_OP, 'occurred_at', clock_timestamp(),
        'record', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
        'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END
    )::text;
    -- Never send truncated JSON or keep an unbounded copy of a failed event.
    omitted := jsonb_build_object('version', 1, 'id', event_id, 'schema', TG_TABLE_SCHEMA,
        'table', TG_TABLE_NAME, 'type', TG_OP, 'record', NULL, 'old_record', NULL,
        'payload_omitted', true)::text;
    IF octet_length(body) > 262144 THEN
        failure := 'payload_too_large';
    END IF;
    INSERT INTO nelcota.webhook_deliveries
        (endpoint_id, event_id, schema_name, table_name, event, url, payload, max_attempts, status, last_error, finished_at)
    SELECT e.id, event_id, TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, e.url,
        CASE WHEN admission.reason IS NULL THEN body ELSE omitted END, e.max_attempts,
        CASE WHEN admission.reason IS NULL THEN 'pending' ELSE 'failed' END, admission.reason,
        CASE WHEN admission.reason IS NULL THEN NULL ELSE clock_timestamp() END
    FROM nelcota.webhook_endpoints e
    CROSS JOIN LATERAL (
        SELECT coalesce(failure, CASE WHEN coalesce(sum(q.outstanding), 0) >= 10000 THEN 'queue_full' END) AS reason
        FROM nelcota.webhook_queue_shards q WHERE q.endpoint_id = e.id
    ) admission
    WHERE e.table_oid = TG_RELID AND e.enabled AND e.deleted_at IS NULL AND TG_OP = ANY(e.events);
    RETURN NULL;
END $$;

REVOKE ALL ON nelcota.webhook_queue_shards, nelcota.webhook_queue_usage
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION nelcota.create_webhook_queue_shards(), nelcota.adjust_webhook_queue(uuid, bigint)
    FROM PUBLIC;
COMMENT ON TABLE nelcota.webhook_deliveries IS 'At-least-once deliveries. Terminal history is retained for 7 days and at most 100,000 rows. Deduplicate on event_id.';
