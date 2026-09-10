-- Performance audit: support admin-wide playback time-range analytics and
-- entity-scoped audit history without scanning their full history tables.

CREATE INDEX IF NOT EXISTS playback_history_started_at_idx
    ON playback_history (started_at, id);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx
    ON audit_log (entity_type, entity_id, created_at DESC);
