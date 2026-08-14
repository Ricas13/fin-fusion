BEGIN;

CREATE TABLE IF NOT EXISTS jellyfin_server_metrics (
    server_id UUID PRIMARY KEY REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    total_users INTEGER CHECK (total_users IS NULL OR total_users >= 0),
    active_streams INTEGER CHECK (active_streams IS NULL OR active_streams >= 0),
    managed_streams INTEGER CHECK (managed_streams IS NULL OR managed_streams >= 0),
    transcode_streams INTEGER CHECK (transcode_streams IS NULL OR transcode_streams >= 0),
    direct_stream_streams INTEGER CHECK (direct_stream_streams IS NULL OR direct_stream_streams >= 0),
    direct_play_streams INTEGER CHECK (direct_play_streams IS NULL OR direct_play_streams >= 0),
    paused_streams INTEGER CHECK (paused_streams IS NULL OR paused_streams >= 0),
    observed_at TIMESTAMPTZ,
    last_error TEXT,
    error_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jellyfin_server_metrics_observed_idx
    ON jellyfin_server_metrics(observed_at DESC);

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='steamfusion_activity') THEN
        GRANT SELECT,INSERT,UPDATE ON jellyfin_server_metrics TO steamfusion_activity;
    END IF;
END
$grant$;

COMMIT;
