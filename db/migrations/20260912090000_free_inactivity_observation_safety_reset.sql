BEGIN;

-- The access_lane_changed_at column was introduced after some Free Server
-- accounts had already existed for a long time. Its original backfill used the
-- row's historical updated_at value as a best-effort lane boundary. That value
-- is not authoritative: an unrelated old policy/account update can sit after
-- genuine Free playback and make an established user look like a "never played"
-- allocation.
--
-- Do NOT rewrite access_lane_changed_at here. Doing that would turn every
-- established Free account into a brand-new allocation and could apply the
-- shorter first-play grace to a user who had already activated legitimately.
-- Instead, mark only accounts whose lane boundary came from the original
-- pre-column backfill. Runtime inactivity policy gives those ambiguous legacy
-- rows one full retention/usage observation window from this migration before
-- any destructive decision. Explicit paid->Free transitions recorded after the
-- original migration remain untouched and keep their precise lane boundary.
ALTER TABLE jellyfin_accounts
    ADD COLUMN IF NOT EXISTS inactivity_observation_reset_at timestamptz;

WITH lane_tracking AS (
    SELECT applied_at
    FROM schema_migrations
    WHERE filename='20260908170000_free_account_lane_transition_tracking.sql'
    LIMIT 1
)
UPDATE jellyfin_accounts ja
SET inactivity_observation_reset_at=NOW()
FROM lane_tracking lt
WHERE ja.account_purpose='jellyfin'
  AND ja.access_lane='free'
  AND ja.disabled=FALSE
  AND ja.access_lane_changed_at<=lt.applied_at;

COMMENT ON COLUMN jellyfin_accounts.access_lane_changed_at IS
'When this account most recently started serving its current access_lane. Explicit lane changes set this in application code; corrective inactivity safety must not rewrite this boundary.';

COMMENT ON COLUMN jellyfin_accounts.inactivity_observation_reset_at IS
'One-time safety observation reference for legacy Free-lane rows whose access_lane_changed_at was historically backfilled and cannot be reconstructed exactly. Null for normal/explicit lane transitions.';

COMMIT;
