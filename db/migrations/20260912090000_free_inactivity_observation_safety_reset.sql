BEGIN;

-- The access_lane_changed_at column was introduced after some Free Server
-- accounts had already existed for a long time. Its original backfill used the
-- row's historical updated_at value as a best-effort lane boundary. That value
-- is not authoritative: an unrelated old policy/account update can predate the
-- migration by days or months, causing genuine Free playback before that
-- guessed boundary to be ignored and making an established user look like a
-- long-idle "never played" allocation immediately after deployment.
--
-- There is no reliable way to reconstruct the historical lane transition for
-- those pre-existing rows. The safe destructive-policy choice is therefore to
-- grant every currently enabled Free-lane Jellyfin account one fresh observation
-- window when this corrective migration is applied. Future paid->Free lane
-- transitions continue to set access_lane_changed_at explicitly in application
-- code and are not affected after this one-time reset.
UPDATE jellyfin_accounts
SET access_lane_changed_at = NOW()
WHERE account_purpose='jellyfin'
  AND access_lane='free'
  AND disabled=FALSE;

COMMENT ON COLUMN jellyfin_accounts.access_lane_changed_at IS
'When this account most recently started serving its current access_lane. Explicit future lane changes set this in application code. Existing Free accounts received a one-time fresh observation window in 20260912090000 because their pre-column historical lane boundary could not be reconstructed safely.';

COMMIT;
