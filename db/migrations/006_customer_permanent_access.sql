ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS permanent_access BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS permanent_access_reason TEXT,
    ADD COLUMN IF NOT EXISTS permanent_access_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS permanent_access_by UUID;

COMMENT ON COLUMN customers.permanent_access IS
    'Administrator override: keep the customer''s most recent non-addon entitlement effective beyond its normal expiry. Explicit access holds still block service.';
COMMENT ON COLUMN customers.permanent_access_reason IS
    'Operator reason recorded when permanent access was enabled.';
