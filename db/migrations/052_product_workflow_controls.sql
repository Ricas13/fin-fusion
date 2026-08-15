BEGIN;

-- Make reseller catalogue semantics explicit rather than inferring behavior from
-- whether rule rows happen to exist. Existing tiers with explicit rules retain
-- that behavior on upgrade; all others are explicitly all-eligible.
ALTER TABLE reseller_tiers
    ADD COLUMN IF NOT EXISTS catalogue_mode TEXT NOT NULL DEFAULT 'all_eligible';
ALTER TABLE reseller_tiers DROP CONSTRAINT IF EXISTS reseller_tiers_catalogue_mode_check;
ALTER TABLE reseller_tiers ADD CONSTRAINT reseller_tiers_catalogue_mode_check
    CHECK (catalogue_mode IN ('all_eligible','allowlist'));
UPDATE reseller_tiers rt SET catalogue_mode='allowlist'
WHERE EXISTS(SELECT 1 FROM reseller_tier_plan_rules r WHERE r.tier_id=rt.id AND r.active=TRUE);

-- Business identity used on reseller receipts/exports.
ALTER TABLE resellers
    ADD COLUMN IF NOT EXISTS legal_name TEXT,
    ADD COLUMN IF NOT EXISTS tax_id TEXT,
    ADD COLUMN IF NOT EXISTS invoice_address TEXT,
    ADD COLUMN IF NOT EXISTS receipt_prefix TEXT,
    ADD COLUMN IF NOT EXISTS customer_portal_policy TEXT NOT NULL DEFAULT 'optional';
ALTER TABLE resellers DROP CONSTRAINT IF EXISTS resellers_customer_portal_policy_check;
ALTER TABLE resellers ADD CONSTRAINT resellers_customer_portal_policy_check
    CHECK (customer_portal_policy IN ('jellyfin_only','optional','portal_required'));

-- Customer creation/provisioning workflow is explicit and auditable.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS provisioning_mode TEXT NOT NULL DEFAULT 'immediate',
    ADD COLUMN IF NOT EXISTS activation_deadline TIMESTAMPTZ;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_provisioning_mode_check;
ALTER TABLE customers ADD CONSTRAINT customers_provisioning_mode_check
    CHECK (provisioning_mode IN ('immediate','after_activation','portal_only'));

-- Version families let admins clone commercial products safely rather than
-- mutating an established product in place.
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS version_group_id UUID,
    ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS effective_until TIMESTAMPTZ;
UPDATE plans SET version_group_id=COALESCE(version_group_id,id);
CREATE INDEX IF NOT EXISTS plans_version_group_idx ON plans(version_group_id,version_number DESC);

ALTER TABLE reseller_tiers
    ADD COLUMN IF NOT EXISTS version_group_id UUID,
    ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS effective_from TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS effective_until TIMESTAMPTZ;
UPDATE reseller_tiers SET version_group_id=COALESCE(version_group_id,id);
CREATE INDEX IF NOT EXISTS reseller_tiers_version_group_idx ON reseller_tiers(version_group_id,version_number DESC);

-- Dynamic operational findings remain source-owned; this table stores the
-- operator workflow around them (acknowledge/assign/note/resolve).
CREATE TABLE IF NOT EXISTS attention_state (
    item_key TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved','ignored')),
    assigned_to UUID REFERENCES app_users(id) ON DELETE SET NULL,
    note TEXT,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attention_state_status_idx ON attention_state(status,updated_at DESC);

-- Product-wide support/legal/contact configuration.
INSERT INTO platform_settings(setting_key,setting_value)
VALUES('support_policy_v1',jsonb_build_object(
    'supportEmail','',
    'supportUrl','',
    'statusUrl','',
    'termsUrl','',
    'privacyUrl','',
    'refundPolicyUrl','',
    'companyName','',
    'companyAddress','',
    'companyTaxId',''
)) ON CONFLICT(setting_key) DO NOTHING;

-- Cleanup policy for abandoned unactivated portal accounts.
INSERT INTO platform_settings(setting_key,setting_value)
VALUES('activation_cleanup_v1',jsonb_build_object(
    'enabled',false,
    'retentionDays',30,
    'warningDays',7
)) ON CONFLICT(setting_key) DO NOTHING;

COMMIT;
