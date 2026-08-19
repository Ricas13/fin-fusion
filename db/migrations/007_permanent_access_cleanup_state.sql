ALTER TABLE customer_entitlement_overrides
    ADD COLUMN IF NOT EXISTS previous_automation_protected boolean,
    ADD COLUMN IF NOT EXISTS previous_automation_reason text;

COMMENT ON COLUMN customer_entitlement_overrides.previous_automation_protected IS 'Cleanup-protection state before permanent access was enabled, restored when the override is revoked.';
