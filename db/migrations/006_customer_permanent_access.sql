ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS permanent_access BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS permanent_access_reason TEXT,
    ADD COLUMN IF NOT EXISTS permanent_access_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS permanent_access_by UUID;

UPDATE customers
SET automation_protected=TRUE,
    automation_protected_reason=COALESCE(automation_protected_reason,'Permanent customer access'),
    automation_protected_at=COALESCE(automation_protected_at,NOW())
WHERE permanent_access=TRUE AND automation_protected=FALSE;

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_permanent_requires_cleanup_protection;
ALTER TABLE customers
    ADD CONSTRAINT customers_permanent_requires_cleanup_protection
    CHECK (permanent_access=FALSE OR automation_protected=TRUE);

COMMENT ON COLUMN customers.permanent_access IS
    'Administrator override: keep the customer''s most recent non-addon entitlement effective beyond its normal expiry. Explicit access holds still block service.';
COMMENT ON COLUMN customers.permanent_access_reason IS
    'Operator reason recorded when permanent access was enabled.';
