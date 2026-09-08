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

UPDATE jellyfin_accounts
SET access_lane_changed_at=created_at
WHERE access_lane_changed_at IS NULL;

ALTER TABLE jellyfin_accounts
    ALTER COLUMN access_lane_changed_at SET DEFAULT NOW(),
    ALTER COLUMN access_lane_changed_at SET NOT NULL;

COMMENT ON COLUMN jellyfin_accounts.access_lane_changed_at IS
'When this account most recently started serving its current access_lane. Equal to created_at unless the account was later adopted into a different lane (see adoptExistingFreeAccount). playback_history recorded before this timestamp belongs to a previous lane and must never count as evidence for the current one.';

COMMIT;
