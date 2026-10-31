-- An idempotent refresh retry: a rotation stores its successor on the rotated
-- token's row, encrypted under a key derived from that token's plaintext. Only
-- whoever presents the rotated token can recover the successor, and only
-- within the retry window; the server clears it once the window has passed.
-- Nullable with no default, so adding it does not rewrite the table. The
-- existing table grant to nelcota_auth covers the new column.
ALTER TABLE auth.refresh_tokens ADD COLUMN retry_successor bytea;
-- At most one row per session holds a successor; pruning finds them here.
CREATE INDEX refresh_tokens_retry_successor_idx ON auth.refresh_tokens (session_id)
    WHERE retry_successor IS NOT NULL;
COMMENT ON COLUMN auth.refresh_tokens.retry_successor IS
    'Successor issued by this token''s rotation, encrypted under a key derived from this token; cleared after the retry window.';
