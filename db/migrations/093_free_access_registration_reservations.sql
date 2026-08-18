BEGIN;

ALTER TABLE pending_registrations
    ADD COLUMN IF NOT EXISTS free_access_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS free_access_registration_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pending_registration_id UUID NOT NULL UNIQUE REFERENCES pending_registrations(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    normalized_email TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (NOT (consumed_at IS NOT NULL AND released_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS free_access_registration_reservations_plan_expiry_idx
    ON free_access_registration_reservations(plan_id, expires_at);
CREATE INDEX IF NOT EXISTS free_access_registration_reservations_email_idx
    ON free_access_registration_reservations(normalized_email, expires_at);

COMMIT;
