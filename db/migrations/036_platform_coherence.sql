BEGIN;

-- Subscription sources are a durable business classification.  Keep the
-- database constraint in step with supported acquisition paths so a free-plan
-- claim cannot fail after the application has already accepted it.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_source_check;
ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_source_check
    CHECK (source IN ('manual','reseller_credit','stripe','paypal','migration','free_claim','reseller_sale','admin_grant'));

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS replaced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS replacement_reason TEXT;
CREATE INDEX IF NOT EXISTS subscriptions_effective_customer_idx
    ON subscriptions(customer_id,current_period_end DESC,created_at DESC)
    WHERE superseded_by IS NULL;

-- New recurring billing agreements are prevented from silently overlapping.
-- Existing historical data is left untouched so the migration remains safe;
-- the trigger applies to future inserts/updates only.
CREATE OR REPLACE FUNCTION enforce_single_live_customer_recurring_subscription()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source IN ('stripe','paypal')
       AND NEW.status IN ('active','trialing','past_due','paused')
       AND NEW.current_period_end > NOW()
       AND ((NEW.source='stripe' AND COALESCE(NEW.provider_subscription_id,'') LIKE 'sub\_%' ESCAPE '\\')
         OR (NEW.source='paypal' AND COALESCE(NEW.provider_subscription_id,'') LIKE 'I-%'))
       AND EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.customer_id=NEW.customer_id
              AND s.id<>NEW.id
              AND s.superseded_by IS NULL
              AND s.source IN ('stripe','paypal')
              AND s.status IN ('active','trialing','past_due','paused')
              AND s.current_period_end>NOW()
              AND ((s.source='stripe' AND COALESCE(s.provider_subscription_id,'') LIKE 'sub\_%' ESCAPE '\\')
                OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') LIKE 'I-%'))
       ) THEN
        RAISE EXCEPTION 'Customer already has a live recurring provider subscription';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS single_live_customer_recurring_subscription_trigger ON subscriptions;
CREATE TRIGGER single_live_customer_recurring_subscription_trigger
BEFORE INSERT OR UPDATE OF customer_id,status,source,current_period_end,provider_subscription_id,superseded_by
ON subscriptions FOR EACH ROW EXECUTE FUNCTION enforce_single_live_customer_recurring_subscription();

-- Independent access holds compose safely.  The legacy columns on customers
-- remain as a derived compatibility summary while old callers are migrated.
CREATE TABLE IF NOT EXISTS customer_access_holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    hold_type TEXT NOT NULL,
    source_key TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at TIMESTAMPTZ,
    released_by UUID REFERENCES app_users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_access_holds_active_unique
    ON customer_access_holds(customer_id,hold_type,source_key)
    WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_access_holds_customer_active_idx
    ON customer_access_holds(customer_id,created_at)
    WHERE released_at IS NULL;

INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason,created_at)
SELECT id,
       CASE
           WHEN COALESCE(access_hold_reason,'') LIKE 'reseller_subscription:%' THEN 'reseller_subscription'
           WHEN COALESCE(access_hold_reason,'') LIKE 'reseller_manual:%' THEN 'reseller_manual'
           WHEN access_hold_reason='disabled' THEN 'admin_disabled'
           WHEN access_hold_reason='suspended' THEN 'admin_suspended'
           ELSE 'legacy'
       END,
       COALESCE(access_hold_reason,''),
       COALESCE(access_hold_reason,'Legacy access hold'),
       COALESCE(access_paused_at,NOW())
FROM customers
WHERE access_paused_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- Reseller commercial settings and tier snapshots.  Editing a tier affects new
-- subscriptions, not what an existing paid subscription says it bought.
ALTER TABLE reseller_tiers
    ADD COLUMN IF NOT EXISTS grace_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 30);

ALTER TABLE reseller_subscriptions
    ADD COLUMN IF NOT EXISTS tier_name_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS monthly_price_minor_snapshot INTEGER,
    ADD COLUMN IF NOT EXISTS currency_snapshot CHAR(3),
    ADD COLUMN IF NOT EXISTS seat_limit_snapshot INTEGER,
    ADD COLUMN IF NOT EXISTS grace_days_snapshot INTEGER,
    ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ;

UPDATE reseller_subscriptions rs
SET tier_name_snapshot=COALESCE(rs.tier_name_snapshot,rt.name),
    monthly_price_minor_snapshot=COALESCE(rs.monthly_price_minor_snapshot,rt.monthly_price_minor),
    currency_snapshot=COALESCE(rs.currency_snapshot,rt.currency),
    seat_limit_snapshot=COALESCE(rs.seat_limit_snapshot,rt.seat_limit),
    grace_days_snapshot=COALESCE(rs.grace_days_snapshot,rt.grace_days)
FROM reseller_tiers rt
WHERE rt.id=rs.tier_id;

CREATE OR REPLACE FUNCTION snapshot_reseller_tier_terms()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t reseller_tiers%ROWTYPE;
BEGIN
    IF TG_OP='INSERT' OR NEW.tier_id IS DISTINCT FROM OLD.tier_id THEN
        SELECT * INTO t FROM reseller_tiers WHERE id=NEW.tier_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Reseller tier not found'; END IF;
        NEW.tier_name_snapshot := t.name;
        NEW.monthly_price_minor_snapshot := t.monthly_price_minor;
        NEW.currency_snapshot := t.currency;
        NEW.seat_limit_snapshot := t.seat_limit;
        NEW.grace_days_snapshot := t.grace_days;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS snapshot_reseller_tier_terms_trigger ON reseller_subscriptions;
CREATE TRIGGER snapshot_reseller_tier_terms_trigger
BEFORE INSERT OR UPDATE OF tier_id ON reseller_subscriptions
FOR EACH ROW EXECUTE FUNCTION snapshot_reseller_tier_terms();

ALTER TABLE resellers
    ADD COLUMN IF NOT EXISTS ledger_currency CHAR(3) NOT NULL DEFAULT 'GBP',
    ADD COLUMN IF NOT EXISTS allowed_payment_methods TEXT[] NOT NULL DEFAULT ARRAY['Cash','Bank transfer','PayPal','Stripe','Other']::text[],
    ADD COLUMN IF NOT EXISTS owner_account_allowed BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS reseller_tier_plan_rules (
    tier_id UUID NOT NULL REFERENCES reseller_tiers(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    allow_customer BOOLEAN NOT NULL DEFAULT TRUE,
    allow_owner BOOLEAN NOT NULL DEFAULT TRUE,
    allow_trial BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(tier_id,plan_id)
);

ALTER TABLE reseller_sales
    ADD COLUMN IF NOT EXISTS sale_type TEXT NOT NULL DEFAULT 'sale',
    ADD COLUMN IF NOT EXISTS parent_sale_id UUID REFERENCES reseller_sales(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS external_reference TEXT,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE reseller_sales DROP CONSTRAINT IF EXISTS reseller_sales_sale_type_check;
ALTER TABLE reseller_sales
    ADD CONSTRAINT reseller_sales_sale_type_check
    CHECK (sale_type IN ('sale','refund','void','adjustment','complimentary','owner_access'));
CREATE INDEX IF NOT EXISTS reseller_sales_parent_idx ON reseller_sales(parent_sale_id);

-- A local intent exists before leaving CAPTAiNFiN for a hosted checkout.  The
-- partial unique indexes make double-clicks/concurrent requests idempotent.
CREATE TABLE IF NOT EXISTS billing_checkout_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope TEXT NOT NULL CHECK (scope IN ('customer','reseller')),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    reseller_id UUID REFERENCES resellers(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
    tier_id UUID REFERENCES reseller_tiers(id) ON DELETE SET NULL,
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal')),
    checkout_mode TEXT NOT NULL CHECK (checkout_mode IN ('payment','subscription')),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','completed','cancelled','expired','failed')),
    nonce_hash TEXT NOT NULL,
    provider_checkout_id TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((scope='customer' AND customer_id IS NOT NULL AND reseller_id IS NULL)
        OR (scope='reseller' AND reseller_id IS NOT NULL AND customer_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS checkout_intents_customer_open_unique
    ON billing_checkout_intents(customer_id) WHERE scope='customer' AND state='open';
CREATE UNIQUE INDEX IF NOT EXISTS checkout_intents_reseller_open_unique
    ON billing_checkout_intents(reseller_id) WHERE scope='reseller' AND state='open';
CREATE UNIQUE INDEX IF NOT EXISTS checkout_intents_provider_unique
    ON billing_checkout_intents(provider,provider_checkout_id)
    WHERE provider_checkout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS checkout_intents_expiry_idx ON billing_checkout_intents(state,expires_at);

CREATE OR REPLACE FUNCTION enforce_single_live_reseller_recurring_subscription()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source IN ('stripe','paypal')
       AND NEW.status IN ('active','past_due')
       AND NEW.current_period_end > NOW()
       AND EXISTS (
            SELECT 1 FROM reseller_subscriptions rs
            WHERE rs.reseller_id=NEW.reseller_id AND rs.id<>NEW.id
              AND rs.source IN ('stripe','paypal')
              AND rs.status IN ('active','past_due')
              AND rs.current_period_end>NOW()
       ) THEN
        RAISE EXCEPTION 'Reseller already has a live recurring provider subscription';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS single_live_reseller_recurring_subscription_trigger ON reseller_subscriptions;
CREATE TRIGGER single_live_reseller_recurring_subscription_trigger
BEFORE INSERT OR UPDATE OF reseller_id,status,source,current_period_end
ON reseller_subscriptions FOR EACH ROW EXECUTE FUNCTION enforce_single_live_reseller_recurring_subscription();

-- Singleton background job state/health.  The worker uses PostgreSQL advisory
-- locks in addition to this table, so multiple app/worker replicas cannot run
-- the same singleton sweep concurrently.
CREATE TABLE IF NOT EXISTS automation_job_state (
    job_key TEXT PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 30 AND 86400),
    last_started_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
    last_duration_ms INTEGER,
    last_processed_count INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    next_run_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO automation_job_state(job_key,interval_seconds) VALUES
 ('health',300),('entitlements',300),('bulk_jobs',30),('stale_reclaim',60),
 ('email_outbox',60),('request_users',900),('billing',900),
 ('reseller_billing',900),('reseller_estates',300)
ON CONFLICT(job_key) DO NOTHING;

INSERT INTO platform_settings(setting_key,setting_value)
VALUES ('reseller_defaults_v2', jsonb_build_object(
    'ledgerCurrency','GBP',
    'paymentMethods',jsonb_build_array('Cash','Bank transfer','PayPal','Stripe','Other'),
    'ownerAccountAllowed',true,
    'defaultTierId',NULL
)) ON CONFLICT(setting_key) DO NOTHING;

INSERT INTO notification_preferences(event_type) VALUES
 ('reseller.subscription.activated'),('reseller.payment.failed'),('reseller.grace.started'),
 ('reseller.estate.suspended'),('reseller.estate.restored'),('reseller.tier.changed'),
 ('reseller.seats.warning'),('reseller.customer.expiring')
ON CONFLICT(event_type) DO NOTHING;

COMMIT;
