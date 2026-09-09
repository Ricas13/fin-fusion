BEGIN;

ALTER TABLE public.request_user_sync
    ADD COLUMN IF NOT EXISTS sync_lease_owner uuid,
    ADD COLUMN IF NOT EXISTS sync_lease_until timestamptz;

CREATE INDEX IF NOT EXISTS request_user_sync_active_lease_idx
    ON public.request_user_sync(sync_lease_until)
    WHERE sync_lease_until IS NOT NULL;

-- Expired leases are deliberately reclaimable. A process may die after it has
-- created the remote Overseerr/Seerr user but before persisting external_user_id;
-- the next owner refreshes remote state under the lease before creating again,
-- so recovery does not duplicate the external identity.
UPDATE public.request_user_sync
SET sync_lease_owner=NULL,
    sync_lease_until=NULL,
    updated_at=NOW()
WHERE sync_lease_until IS NOT NULL
  AND sync_lease_until<=NOW();

COMMIT;
