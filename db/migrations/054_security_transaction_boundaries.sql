BEGIN;

-- Email changes are security-sensitive identity changes. Keep the currently
-- verified address authoritative until the replacement address proves
-- ownership, so a stolen authenticated session cannot redirect password reset.
ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS pending_email TEXT,
    ADD COLUMN IF NOT EXISTS pending_email_requested_at TIMESTAMPTZ;

ALTER TABLE account_tokens
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE account_tokens DROP CONSTRAINT IF EXISTS account_tokens_token_type_check;
ALTER TABLE account_tokens
    ADD CONSTRAINT account_tokens_token_type_check
    CHECK (token_type IN ('email_verify','password_reset','email_change'));
CREATE INDEX IF NOT EXISTS account_tokens_user_type_open_idx
    ON account_tokens(user_id,token_type,expires_at)
    WHERE consumed_at IS NULL;

-- Hosted checkout is a commercial commitment. Snapshot the terms/mapping that
-- were offered before redirecting to the provider so catalogue retirement or
-- later edits cannot make a successfully-paid checkout impossible to fulfil.
ALTER TABLE billing_checkout_intents
    ADD COLUMN IF NOT EXISTS commercial_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Reserve limited-use promotions while a hosted checkout is in flight. A
-- provider-side discount must not be allowed to exceed the local configured
-- redemption cap just because two customers pay concurrently.
CREATE TABLE IF NOT EXISTS discount_checkout_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discount_code_id UUID NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    checkout_intent_id UUID NOT NULL UNIQUE REFERENCES billing_checkout_intents(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','consumed','released','expired')),
    amount_applied_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_applied_minor >= 0),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS discount_checkout_reservations_code_open_idx
    ON discount_checkout_reservations(discount_code_id,expires_at)
    WHERE state='reserved';
CREATE INDEX IF NOT EXISTS discount_checkout_reservations_customer_open_idx
    ON discount_checkout_reservations(customer_id,discount_code_id)
    WHERE state='reserved';

-- External-provider mutations are not atomic with PostgreSQL. Persist a small
-- saga/journal before touching Stripe/PayPal so a crash after remote success can
-- be reconciled instead of silently leaving remote and local state divergent.
CREATE TABLE IF NOT EXISTS provider_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal')),
    scope TEXT NOT NULL CHECK (scope IN ('customer','reseller')),
    owner_id UUID NOT NULL,
    operation_type TEXT NOT NULL,
    local_reference TEXT,
    provider_reference TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_result JSONB NOT NULL DEFAULT '{}'::jsonb,
    state TEXT NOT NULL DEFAULT 'planned'
        CHECK (state IN ('planned','provider_applied','local_applied','reconciled','compensated','failed')),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    provider_applied_at TIMESTAMPTZ,
    local_applied_at TIMESTAMPTZ,
    reconciled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS provider_operations_attention_idx
    ON provider_operations(state,updated_at DESC)
    WHERE state IN ('planned','provider_applied','failed');
CREATE INDEX IF NOT EXISTS provider_operations_owner_idx
    ON provider_operations(scope,owner_id,created_at DESC);

-- Exactly one database definition of contractual/effective customer access.
-- It deliberately does NOT require the current catalogue plan to be active.
-- A paid contract is immutable business history; catalogue retirement only
-- controls whether a new contract may be sold.
CREATE OR REPLACE VIEW effective_customer_entitlements AS
SELECT DISTINCT ON (s.customer_id)
    s.customer_id,
    s.id AS subscription_id,
    s.plan_id,
    s.status,
    s.source,
    s.starts_at,
    s.current_period_end,
    COALESCE(s.service_extension_days,0) AS service_extension_days,
    s.current_period_end + (COALESCE(s.service_extension_days,0)||' days')::interval AS access_expires_at,
    s.cancel_at_period_end,
    s.provider_customer_id,
    s.provider_subscription_id,
    s.plan_name_snapshot,
    s.plan_code_snapshot,
    s.price_minor_snapshot,
    s.currency_snapshot,
    s.billing_interval_snapshot,
    s.duration_days_snapshot,
    s.provider_price_id_snapshot,
    p.code,
    p.name,
    p.audience,
    p.billing_interval,
    p.duration_days,
    p.price_minor,
    p.currency,
    p.streams,
    p.allow_downloads,
    p.allow_video_transcoding,
    p.allow_audio_transcoding,
    p.allow_live_tv,
    p.allow_live_tv_management,
    p.server_class,
    p.request_movie_quota_limit,
    p.request_movie_quota_days,
    p.request_tv_quota_limit,
    p.request_tv_quota_days,
    EXISTS (
        SELECT 1 FROM customer_access_holds h
        WHERE h.customer_id=s.customer_id AND h.released_at IS NULL
    ) AS blocked
FROM subscriptions s
JOIN plans p ON p.id=s.plan_id
WHERE s.superseded_by IS NULL
  AND s.starts_at<=NOW()
  AND (
      (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
      OR (
          COALESCE(s.service_extension_days,0)>0
          AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
          AND s.current_period_end+(s.service_extension_days||' days')::interval>NOW()
      )
  )
ORDER BY s.customer_id,
         (s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval) DESC,
         s.created_at DESC;

-- Once a reseller has scheduled a smaller Stripe tier, the target seat limit
-- becomes the temporary ceiling immediately. Otherwise the reseller can fill
-- more seats after scheduling and leave Stripe lowering the invoice while the
-- local estate refuses the smaller tier at the renewal boundary.
CREATE OR REPLACE FUNCTION enforce_pending_reseller_tier_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    reseller_uuid UUID;
    target_limit INTEGER;
    used_count INTEGER;
    contributes BOOLEAN;
BEGIN
    IF NEW.source <> 'reseller_sale' OR NEW.superseded_by IS NOT NULL THEN
        RETURN NEW;
    END IF;
    contributes := NEW.starts_at <= NOW()
        AND NEW.status IN ('active','trialing','past_due','paused')
        AND NEW.current_period_end + (COALESCE(NEW.service_extension_days,0)||' days')::interval > NOW();
    IF NOT contributes THEN RETURN NEW; END IF;
    SELECT c.reseller_id INTO reseller_uuid FROM customers c WHERE c.id=NEW.customer_id;
    IF reseller_uuid IS NULL THEN RETURN NEW; END IF;
    SELECT rt.seat_limit INTO target_limit
    FROM reseller_subscriptions rs
    JOIN reseller_tiers rt ON rt.id=rs.pending_tier_id
    WHERE rs.reseller_id=reseller_uuid
      AND rs.pending_tier_id IS NOT NULL
      AND rs.status IN ('active','past_due')
      AND rs.current_period_end>NOW()
    ORDER BY rs.current_period_end DESC,rs.created_at DESC
    LIMIT 1;
    IF target_limit IS NULL THEN RETURN NEW; END IF;
    SELECT COUNT(DISTINCT e.customer_id)::int INTO used_count
    FROM effective_customer_entitlements e
    JOIN customers c ON c.id=e.customer_id
    WHERE c.reseller_id=reseller_uuid
      AND e.source='reseller_sale'
      AND e.customer_id<>NEW.customer_id;
    IF COALESCE(used_count,0)+1 > target_limit THEN
        RAISE EXCEPTION 'Pending reseller tier change limits this estate to % active seats', target_limit;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pending_reseller_tier_capacity_trigger ON subscriptions;
CREATE TRIGGER pending_reseller_tier_capacity_trigger
BEFORE INSERT OR UPDATE OF customer_id,status,source,starts_at,current_period_end,service_extension_days,superseded_by
ON subscriptions FOR EACH ROW EXECUTE FUNCTION enforce_pending_reseller_tier_capacity();

-- Audit history is security evidence. Application code may append but must not
-- rewrite or delete existing evidence. Emergency DBA maintenance can opt in
-- explicitly for one transaction with:
--   SET LOCAL steamfusion.allow_audit_mutation='on';
CREATE OR REPLACE FUNCTION protect_audit_log_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('steamfusion.allow_audit_mutation',true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'audit_log is append-only';
    END IF;
    RETURN COALESCE(NEW,OLD);
END;
$$;
DROP TRIGGER IF EXISTS audit_log_append_only_trigger ON audit_log;
CREATE TRIGGER audit_log_append_only_trigger
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION protect_audit_log_history();

-- The older attention_workflow implementation is completely unreferenced; the
-- live operator workflow uses attention_state. Remove the duplicate schema so
-- future work cannot accidentally start writing to the wrong table.
DROP TABLE IF EXISTS attention_workflow;

-- A simple persisted incident switch lets an administrator stop NEW commerce
-- without revoking existing access during payment-provider incidents.
INSERT INTO platform_settings(setting_key,setting_value)
VALUES('commerce_control_v1',jsonb_build_object(
    'paused',false,
    'reason','',
    'pausedAt',NULL,
    'pausedBy',NULL
)) ON CONFLICT(setting_key) DO NOTHING;

COMMIT;
