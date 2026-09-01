BEGIN;

ALTER TABLE public.free_access_registration_reservations
    ALTER COLUMN pending_registration_id DROP NOT NULL,
    ALTER COLUMN normalized_email DROP NOT NULL;

ALTER TABLE public.free_access_registration_reservations
    ADD COLUMN IF NOT EXISTS holder_session_hash text;

ALTER TABLE public.free_access_registration_reservations
    DROP CONSTRAINT IF EXISTS free_access_registration_reservations_holder_session_hash_format;
ALTER TABLE public.free_access_registration_reservations
    ADD CONSTRAINT free_access_registration_reservations_holder_session_hash_format
    CHECK (holder_session_hash IS NULL OR holder_session_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE public.free_access_registration_reservations
    DROP CONSTRAINT IF EXISTS free_access_registration_reservations_owner_check;
ALTER TABLE public.free_access_registration_reservations
    ADD CONSTRAINT free_access_registration_reservations_owner_check
    CHECK (pending_registration_id IS NOT NULL OR holder_session_hash IS NOT NULL);

CREATE INDEX IF NOT EXISTS free_access_registration_reservations_holder_idx
    ON public.free_access_registration_reservations(holder_session_hash, expires_at)
    WHERE consumed_at IS NULL AND released_at IS NULL;

CREATE INDEX IF NOT EXISTS free_access_registration_reservations_plan_hold_idx
    ON public.free_access_registration_reservations(plan_id, expires_at)
    WHERE consumed_at IS NULL AND released_at IS NULL;

COMMIT;
