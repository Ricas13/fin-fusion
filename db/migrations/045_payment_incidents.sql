BEGIN;

CREATE TABLE IF NOT EXISTS payment_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal')),
    provider_event_id TEXT NOT NULL,
    provider_case_id TEXT,
    incident_type TEXT NOT NULL CHECK (incident_type IN ('refund','dispute','chargeback','failed_renewal')),
    incident_status TEXT NOT NULL DEFAULT 'open' CHECK (incident_status IN ('open','resolved','won','lost','recorded')),
    scope TEXT NOT NULL DEFAULT 'unresolved' CHECK (scope IN ('direct','reseller','unresolved')),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    reseller_id UUID REFERENCES resellers(id) ON DELETE SET NULL,
    provider_subscription_id TEXT,
    amount_minor BIGINT,
    currency CHAR(3),
    access_action TEXT NOT NULL DEFAULT 'preserve' CHECK (access_action IN ('preserve','provider_state','suspend','restore')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider,provider_event_id,incident_type)
);
CREATE INDEX IF NOT EXISTS payment_incidents_case_idx ON payment_incidents(provider,provider_case_id,created_at DESC);
CREATE INDEX IF NOT EXISTS payment_incidents_customer_idx ON payment_incidents(customer_id,created_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_incidents_reseller_idx ON payment_incidents(reseller_id,created_at DESC) WHERE reseller_id IS NOT NULL;

INSERT INTO platform_settings(setting_key,setting_value)
VALUES ('payment_risk_policy',jsonb_build_object(
    'refundAction','preserve',
    'disputeAction','suspend',
    'chargebackAction','suspend',
    'failedRenewalAction','provider_state'
)) ON CONFLICT(setting_key) DO NOTHING;

INSERT INTO notification_preferences(event_type) VALUES
 ('payment.refunded'),
 ('payment.disputed'),
 ('payment.chargeback'),
 ('payment.renewal_failed')
ON CONFLICT(event_type) DO NOTHING;

COMMIT;
