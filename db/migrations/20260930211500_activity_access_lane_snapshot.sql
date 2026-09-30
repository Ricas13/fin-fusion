BEGIN;

-- Preserve the Free/Premium identity of activity rows after the underlying
-- Jellyfin account is deleted (the account FK uses ON DELETE SET NULL) or the
-- same account is later adopted from the paid/primary lane into Free.
ALTER TABLE playback_history
    ADD COLUMN IF NOT EXISTS access_lane_snapshot text;

ALTER TABLE stream_policy_events
    ADD COLUMN IF NOT EXISTS access_lane_snapshot text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='playback_history_access_lane_snapshot_check'
          AND conrelid='playback_history'::regclass
    ) THEN
        ALTER TABLE playback_history
            ADD CONSTRAINT playback_history_access_lane_snapshot_check
            CHECK (access_lane_snapshot IS NULL OR access_lane_snapshot IN ('primary','free'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='stream_policy_events_access_lane_snapshot_check'
          AND conrelid='stream_policy_events'::regclass
    ) THEN
        ALTER TABLE stream_policy_events
            ADD CONSTRAINT stream_policy_events_access_lane_snapshot_check
            CHECK (access_lane_snapshot IS NULL OR access_lane_snapshot IN ('primary','free'));
    END IF;
END
$$;

-- Existing rows that still retain an account reference can be classified from
-- the account. For explicit primary->Free adoptions, access_lane_changed_at is
-- authoritative; playback before that boundary remains primary. Legacy Free
-- accounts marked with inactivity_observation_reset_at have an intentionally
-- ambiguous synthetic boundary, so keep their current Free lane.
UPDATE playback_history ph
SET access_lane_snapshot=COALESCE(
    (
        SELECT CASE
                 WHEN ja.access_lane='free'
                  AND ja.inactivity_observation_reset_at IS NULL
                  AND ph.started_at<ja.access_lane_changed_at
                 THEN 'primary'
                 ELSE ja.access_lane
               END
        FROM jellyfin_accounts ja
        WHERE ja.id=ph.jellyfin_account_id
    ),
    (
        SELECT CASE WHEN js.server_class='free' THEN 'free' ELSE 'primary' END
        FROM jellyfin_servers js
        WHERE js.id=ph.server_id
    )
)
WHERE ph.access_lane_snapshot IS NULL;

UPDATE stream_policy_events spe
SET access_lane_snapshot=COALESCE(
    (
        SELECT CASE
                 WHEN ja.access_lane='free'
                  AND ja.inactivity_observation_reset_at IS NULL
                  AND spe.created_at<ja.access_lane_changed_at
                 THEN 'primary'
                 ELSE ja.access_lane
               END
        FROM jellyfin_accounts ja
        WHERE ja.id=spe.jellyfin_account_id
    ),
    (
        SELECT CASE WHEN js.server_class='free' THEN 'free' ELSE 'primary' END
        FROM jellyfin_servers js
        WHERE js.id=spe.server_id
    )
)
WHERE spe.access_lane_snapshot IS NULL;

CREATE INDEX IF NOT EXISTS playback_history_customer_lane_recent_idx
    ON playback_history(customer_id,access_lane_snapshot,started_at DESC);

CREATE INDEX IF NOT EXISTS stream_policy_events_customer_lane_recent_idx
    ON stream_policy_events(customer_id,access_lane_snapshot,created_at DESC);

COMMENT ON COLUMN playback_history.access_lane_snapshot IS
'Free or primary Jellyfin access lane at playback observation time. Preserved after account deletion and lane transitions.';

COMMENT ON COLUMN stream_policy_events.access_lane_snapshot IS
'Free or primary Jellyfin access lane of the session that produced the policy event.';

COMMIT;
