-- Active playback sessions are ephemeral runtime telemetry and must never outlive
-- the Jellyfin account they reference. Historical databases may contain orphaned
-- rows from before the FK/cascade lifecycle was consistently enforced. They can
-- make an otherwise valid encrypted backup fail full restore verification.
DELETE FROM public.active_playback_sessions aps
WHERE aps.jellyfin_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.jellyfin_accounts ja
    WHERE ja.id = aps.jellyfin_account_id
  );
