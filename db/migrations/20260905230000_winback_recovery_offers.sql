BEGIN;

ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS winback_kind text;
ALTER TABLE discount_codes DROP CONSTRAINT IF EXISTS discount_codes_winback_kind_check;
ALTER TABLE discount_codes ADD CONSTRAINT discount_codes_winback_kind_check
    CHECK (winback_kind IS NULL OR winback_kind IN ('monthly_25','longterm_10'));
CREATE UNIQUE INDEX IF NOT EXISTS discount_codes_winback_kind_unique
    ON discount_codes(winback_kind) WHERE winback_kind IS NOT NULL;

-- These are system-managed codes. The code alone never grants the discount:
-- checkout also requires a live, customer-bound win-back offer.
INSERT INTO discount_codes(
    code,description,discount_type,percent_off,fixed_off_minor,currency,
    plan_codes,max_redemptions,redemption_count,per_customer_limit,
    starts_at,expires_at,active,winback_kind
) VALUES
    ('WELCOME_BACK_25','System win-back: 25% off the first monthly payment','percent',25,NULL,NULL,NULL,NULL,0,1000,NULL,NULL,TRUE,'monthly_25'),
    ('WELCOME_BACK_10','System win-back: 10% off the first 6-month or yearly term','percent',10,NULL,NULL,NULL,NULL,0,1000,NULL,NULL,TRUE,'longterm_10')
ON CONFLICT (code) DO UPDATE SET
    description=EXCLUDED.description,
    discount_type='percent',
    percent_off=EXCLUDED.percent_off,
    fixed_off_minor=NULL,
    currency=NULL,
    plan_codes=NULL,
    max_redemptions=NULL,
    per_customer_limit=GREATEST(discount_codes.per_customer_limit,1000),
    active=TRUE,
    winback_kind=EXCLUDED.winback_kind,
    updated_at=NOW();

-- Prevent deployment from back-filling old cancellations and emailing a large
-- historical audience. Discovery starts at the first activation timestamp.
CREATE TABLE IF NOT EXISTS winback_runtime (
    singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton=TRUE),
    activated_at timestamptz NOT NULL DEFAULT NOW()
);
INSERT INTO winback_runtime(singleton) VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS winback_offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    trigger_subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    trigger_reason text NOT NULL CHECK (trigger_reason IN ('voluntary_cancel','payment_failed')),
    service_type text NOT NULL,
    terminal_at timestamptz NOT NULL,
    eligible_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','sent','redeemed','suppressed','expired')),
    sent_at timestamptz,
    expires_at timestamptz,
    suppression_reason text,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
    next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
    last_error text,
    processing_started_at timestamptz,
    reserved_checkout_intent_id uuid REFERENCES billing_checkout_intents(id) ON DELETE SET NULL,
    reserved_discount_code_id uuid REFERENCES discount_codes(id) ON DELETE SET NULL,
    reservation_expires_at timestamptz,
    redeemed_at timestamptz,
    redeemed_discount_code_id uuid REFERENCES discount_codes(id) ON DELETE SET NULL,
    redeemed_subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE(trigger_subscription_id)
);

CREATE INDEX IF NOT EXISTS winback_offers_due_idx
    ON winback_offers(next_attempt_at,eligible_at)
    WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS winback_offers_customer_sent_idx
    ON winback_offers(customer_id,sent_at DESC)
    WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS winback_offers_customer_active_idx
    ON winback_offers(customer_id,expires_at DESC)
    WHERE status='sent';

COMMIT;
