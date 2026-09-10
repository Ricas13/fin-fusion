-- Playback overlap analytics filters sessions by both their start and effective
-- end timestamps. The existing started_at index handles the upper bound; this
-- expression index lets PostgreSQL prune sessions that ended before the selected
-- dashboard range instead of scanning historical playback that cannot overlap it.
CREATE INDEX IF NOT EXISTS playback_history_effective_end_started_idx
    ON playback_history ((COALESCE(ended_at,last_seen_at)), started_at, id)
    WHERE COALESCE(ended_at,last_seen_at) IS NOT NULL;
