BEGIN;

-- Tracks when a Jellyfin account row most recently started serving its
-- CURRENT access_lane. Needed to fix a real regression: when a paying
-- customer cancels but keeps Free entitlement, resilient-provisioning.js's
-- adoptExistingFreeAccount() reuses their existing primary (paid) Jellyfin
-- account by flipping access_lane to 'free' on the same row, rather than
-- creating a new one. customer-inactivity.js's allocation-scoping logic uses
-- that account's earliest playback_history row as "established Free
-- activation evidence" -- without this column, a customer's months of PAID
-- streaming (recorded against the same jellyfin_account_id, before the
-- lane flip) counts as Free activation evidence, pushing their Free
-- allocation start far into the past and making them eligible for
-- automatic removal on the very first inactivity sweep after downgrading.
ALTER TABLE jellyfin_accounts
    ADD COLUMN IF NOT EXISTS access_lane_changed_at timestamptz;

-- For rows that already existed before this column, the exact historical lane
-- flip timestamp was not stored. A paid->free adoption did, however, update the
-- account row's updated_at timestamp. Use that as a conservative floor for
-- existing Free-lane rows instead of created_at. Later unrelated updates can
-- only move this floor forward, which may grant an existing Free user one extra
-- inactivity grace window after deployment, but cannot wrongly count paid-era
-- playback and delete a freshly downgraded customer. Non-Free rows retain their
-- original creation time until an explicit future lane transition updates it.
UPDATE jellyfin_accounts
SET access_lane_changed_at=CASE
    WHEN access_lane='free' THEN GREATEST(created_at,COALESCE(updated_at,created_at))
    ELSE created_at
END
WHERE access_lane_changed_at IS NULL;

ALTER TABLE jellyfin_accounts
    ALTER COLUMN access_lane_changed_at SET DEFAULT NOW(),
    ALTER COLUMN access_lane_changed_at SET NOT NULL;

COMMENT ON COLUMN jellyfin_accounts.access_lane_changed_at IS
'When this account most recently started serving its current access_lane. Future lane changes set this explicitly. Pre-migration Free rows are conservatively backfilled from their latest account update so paid-era playback cannot be counted as Free activity.';

COMMIT;