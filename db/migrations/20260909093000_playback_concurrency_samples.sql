BEGIN;

CREATE TABLE IF NOT EXISTS playback_concurrency_samples (
    bucket_start timestamptz PRIMARY KEY,
    peak_concurrent_streams integer NOT NULL DEFAULT 0 CHECK (peak_concurrent_streams >= 0),
    peak_playing_streams integer NOT NULL DEFAULT 0 CHECK (peak_playing_streams >= 0),
    peak_paused_streams integer NOT NULL DEFAULT 0 CHECK (peak_paused_streams >= 0),
    peak_transcode_streams integer NOT NULL DEFAULT 0 CHECK (peak_transcode_streams >= 0),
    peak_direct_stream_streams integer NOT NULL DEFAULT 0 CHECK (peak_direct_stream_streams >= 0),
    peak_direct_play_streams integer NOT NULL DEFAULT 0 CHECK (peak_direct_play_streams >= 0),
    peak_unknown_streams integer NOT NULL DEFAULT 0 CHECK (peak_unknown_streams >= 0),
    peak_observed_at timestamptz NOT NULL,
    sample_count integer NOT NULL DEFAULT 1 CHECK (sample_count > 0),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS playback_concurrency_samples_peak_idx
    ON playback_concurrency_samples (peak_concurrent_streams DESC, bucket_start DESC);

-- Fleet metrics are refreshed as one server row at a time. Capture a fleet-wide
-- sample only when every enabled server has a fresh observation from the same
-- refresh window. This prevents a failed/offline server or stale previous-cycle
-- value from being combined into an invented concurrency peak.
CREATE OR REPLACE FUNCTION public.capture_playback_concurrency_sample()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    sample_at timestamptz := COALESCE(NEW.observed_at, NOW());
    sample_bucket timestamptz;
    enabled_servers integer := 0;
    fresh_servers integer := 0;
    concurrent_streams integer := 0;
    paused_streams integer := 0;
    transcode_streams integer := 0;
    direct_stream_streams integer := 0;
    direct_play_streams integer := 0;
    unknown_streams integer := 0;
    playing_streams integer := 0;
BEGIN
    SELECT COUNT(*)::int
      INTO enabled_servers
      FROM jellyfin_servers
     WHERE enabled = TRUE;

    IF enabled_servers <= 0 THEN
        RETURN NEW;
    END IF;

    SELECT COUNT(*)::int,
           COALESCE(SUM(m.active_streams), 0)::int,
           COALESCE(SUM(m.paused_streams), 0)::int,
           COALESCE(SUM(m.transcode_streams), 0)::int,
           COALESCE(SUM(m.direct_stream_streams), 0)::int,
           COALESCE(SUM(m.direct_play_streams), 0)::int
      INTO fresh_servers,
           concurrent_streams,
           paused_streams,
           transcode_streams,
           direct_stream_streams,
           direct_play_streams
      FROM jellyfin_server_metrics m
      JOIN jellyfin_servers s ON s.id = m.server_id
     WHERE s.enabled = TRUE
       AND m.observed_at IS NOT NULL
       AND m.observed_at >= sample_at - INTERVAL '25 seconds'
       AND m.observed_at <= sample_at + INTERVAL '5 seconds';

    -- A partial fleet observation must never become a fleet peak.
    IF fresh_servers <> enabled_servers THEN
        RETURN NEW;
    END IF;

    playing_streams := GREATEST(0, concurrent_streams - paused_streams);
    unknown_streams := GREATEST(
        0,
        concurrent_streams - transcode_streams - direct_stream_streams - direct_play_streams
    );
    sample_bucket := to_timestamp(floor(extract(epoch FROM sample_at) / 300) * 300);

    INSERT INTO playback_concurrency_samples (
        bucket_start,
        peak_concurrent_streams,
        peak_playing_streams,
        peak_paused_streams,
        peak_transcode_streams,
        peak_direct_stream_streams,
        peak_direct_play_streams,
        peak_unknown_streams,
        peak_observed_at,
        sample_count,
        updated_at
    ) VALUES (
        sample_bucket,
        concurrent_streams,
        playing_streams,
        paused_streams,
        transcode_streams,
        direct_stream_streams,
        direct_play_streams,
        unknown_streams,
        sample_at,
        1,
        NOW()
    )
    ON CONFLICT (bucket_start) DO UPDATE SET
        peak_observed_at = CASE
            WHEN EXCLUDED.peak_concurrent_streams > playback_concurrency_samples.peak_concurrent_streams
                THEN EXCLUDED.peak_observed_at
            ELSE playback_concurrency_samples.peak_observed_at
        END,
        peak_concurrent_streams = GREATEST(playback_concurrency_samples.peak_concurrent_streams, EXCLUDED.peak_concurrent_streams),
        peak_playing_streams = GREATEST(playback_concurrency_samples.peak_playing_streams, EXCLUDED.peak_playing_streams),
        peak_paused_streams = GREATEST(playback_concurrency_samples.peak_paused_streams, EXCLUDED.peak_paused_streams),
        peak_transcode_streams = GREATEST(playback_concurrency_samples.peak_transcode_streams, EXCLUDED.peak_transcode_streams),
        peak_direct_stream_streams = GREATEST(playback_concurrency_samples.peak_direct_stream_streams, EXCLUDED.peak_direct_stream_streams),
        peak_direct_play_streams = GREATEST(playback_concurrency_samples.peak_direct_play_streams, EXCLUDED.peak_direct_play_streams),
        peak_unknown_streams = GREATEST(playback_concurrency_samples.peak_unknown_streams, EXCLUDED.peak_unknown_streams),
        sample_count = playback_concurrency_samples.sample_count + 1,
        updated_at = NOW();

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_playback_concurrency_sample() FROM PUBLIC;

DROP TRIGGER IF EXISTS jellyfin_server_metrics_capture_concurrency ON jellyfin_server_metrics;
CREATE TRIGGER jellyfin_server_metrics_capture_concurrency
AFTER INSERT OR UPDATE OF active_streams, transcode_streams, direct_stream_streams, direct_play_streams, paused_streams, observed_at
ON jellyfin_server_metrics
FOR EACH ROW
EXECUTE FUNCTION public.capture_playback_concurrency_sample();

-- The web process reads concurrency through this narrow function instead of
-- receiving direct write access to the telemetry table.
CREATE OR REPLACE FUNCTION public.playback_concurrency_metrics(
    period_start timestamptz,
    period_end timestamptz
)
RETURNS TABLE (
    peak_concurrent_streams integer,
    sample_count bigint,
    coverage_start timestamptz,
    coverage_end timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(MAX(s.peak_concurrent_streams), 0)::int,
           COUNT(*)::bigint,
           MIN(s.bucket_start),
           MAX(s.bucket_start)
      FROM playback_concurrency_samples s
     WHERE s.bucket_start >= period_start
       AND s.bucket_start < period_end;
$$;

REVOKE ALL ON FUNCTION public.playback_concurrency_metrics(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON playback_concurrency_samples FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfusion_app') THEN
        GRANT EXECUTE ON FUNCTION public.playback_concurrency_metrics(timestamptz, timestamptz) TO steamfusion_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfusion_backup') THEN
        GRANT SELECT ON playback_concurrency_samples TO steamfusion_backup;
    END IF;
END;
$$;

COMMIT;
