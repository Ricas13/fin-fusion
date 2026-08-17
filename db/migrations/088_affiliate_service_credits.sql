BEGIN;
CREATE TABLE IF NOT EXISTS affiliate_profiles (
 customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
 active BOOLEAN NOT NULL DEFAULT TRUE,
 enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 disabled_at TIMESTAMPTZ,
 note TEXT NOT NULL DEFAULT '',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS affiliate_credit_ledger (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 currency CHAR(3) NOT NULL CHECK (currency IN ('GBP','USD','EUR')),
 amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
 entry_type TEXT NOT NULL CHECK (entry_type IN ('earned','redeemed','reversed','adjustment')),
 state TEXT NOT NULL DEFAULT 'available' CHECK (state IN ('pending','available','void')),
 referral_redemption_id UUID REFERENCES referral_redemptions(id) ON DELETE SET NULL,
 referred_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
 qualifying_subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
 applied_subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
 payment_incident_id UUID REFERENCES payment_incidents(id) ON DELETE SET NULL,
 available_at TIMESTAMPTZ,
 reference_id TEXT,
 note TEXT NOT NULL DEFAULT '',
 metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(entry_type,reference_id)
);
CREATE INDEX IF NOT EXISTS affiliate_credit_ledger_customer_currency_idx ON affiliate_credit_ledger(customer_id,currency,state,created_at);
CREATE INDEX IF NOT EXISTS affiliate_credit_ledger_referral_idx ON affiliate_credit_ledger(referral_redemption_id);
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_source_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_source_check CHECK (source IN ('manual','reseller_credit','stripe','paypal','migration','admin_grant','service_credit'));
INSERT INTO platform_settings(setting_key,setting_value)
VALUES ('affiliate_program','{"enabled":false,"rewardPercent":15,"qualificationDelayDays":14,"refundWindowDays":14}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;
COMMIT;
