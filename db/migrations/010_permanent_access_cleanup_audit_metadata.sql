ALTER TABLE customer_entitlement_overrides
    ADD COLUMN IF NOT EXISTS previous_automation_protected_at timestamptz,
    ADD COLUMN IF NOT EXISTS previous_automation_protected_by uuid REFERENCES app_users(id) ON DELETE SET NULL;

COMMENT ON COLUMN customer_entitlement_overrides.previous_automation_protected_at IS 'Original cleanup-protection timestamp restored when permanent access is revoked.';
COMMENT ON COLUMN customer_entitlement_overrides.previous_automation_protected_by IS 'Original administrator who set cleanup protection, restored when permanent access is revoked.';
