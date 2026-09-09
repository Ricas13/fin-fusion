BEGIN;

-- Anonymous visitors may express intent to register for Free Access, but a
-- browser session alone must never consume scarce plan capacity. A real
-- capacity reservation is created only once a validated pending registration
-- (email + username + password) exists.
CREATE TABLE IF NOT EXISTS public.free_access_registration_intents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    holder_session_hash text NOT NULL,
    plan_id uuid NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT free_access_registration_intents_holder_hash_format
      CHECK (holder_session_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS free_access_registration_intents_holder_plan_uq
    ON public.free_access_registration_intents(holder_session_hash,plan_id);
CREATE INDEX IF NOT EXISTS free_access_registration_intents_expiry_idx
    ON public.free_access_registration_intents(expires_at);

-- Release anonymous capacity holds created by the previous pre-form flow. They
-- never represented a verified identity and should not continue consuming a
-- Free place after this migration.
UPDATE public.free_access_registration_reservations
SET released_at=COALESCE(released_at,NOW()),updated_at=NOW()
WHERE pending_registration_id IS NULL
  AND customer_id IS NULL
  AND subscription_id IS NULL
  AND consumed_at IS NULL
  AND released_at IS NULL;

COMMENT ON TABLE public.free_access_registration_intents IS
'Non-capacity-holding browser intents for Free registration. Capacity is reserved only when the intent is bound to a validated pending registration.';

COMMIT;
