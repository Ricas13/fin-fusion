BEGIN;

-- A refund/dispute/chargeback under review ("payment_risk") is a commercial
-- incident, not an access state: "a customer asking for a refund is not an
-- access state." Only the absence of a valid entitlement (handled through
-- subscriptions.status/current_period_end) or an explicit administrator
-- decision may remove service access. payment_delinquency remains a
-- legitimate, subscription-scoped signal for an unpaid renewal still inside
-- its grace window (that is the "NOT PAID" case, not a refund/risk hold).
--
-- This must preserve the exact scoping 045_parallel_free_jellyfin_access.sql
-- already introduced for inactivity_policy/jellyfin_cleanup (they only block
-- the free_claim lane, not a simultaneous paid subscription) - only the
-- payment_risk exclusion is new here.
CREATE OR REPLACE FUNCTION public.subscription_access_blocked(
    p_customer_id uuid,
    p_source text,
    p_provider_subscription_id text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.customer_access_holds h
        WHERE h.customer_id=p_customer_id
          AND h.released_at IS NULL
          AND h.hold_type <> 'payment_risk'
          AND (
              (h.hold_type='payment_delinquency' AND h.source_key = CASE
                  WHEN p_source='stripe' AND COALESCE(p_provider_subscription_id,'') LIKE 'sub\_%' ESCAPE '\' THEN 'stripe:' || p_provider_subscription_id
                  WHEN p_source='paypal' AND COALESCE(p_provider_subscription_id,'') LIKE 'I-%' THEN 'paypal:' || p_provider_subscription_id
                  ELSE NULL
              END)
              OR (h.hold_type IN ('inactivity_policy','jellyfin_cleanup') AND p_source='free_claim')
              OR h.hold_type NOT IN ('payment_delinquency','inactivity_policy','jellyfin_cleanup','payment_risk')
          )
    );
$$;

-- Existing payment_risk holds no longer mean anything to access decisions as
-- of the function change above; release them so Customer 360 and hold
-- listings stop presenting them as active blockers. The rows themselves
-- (reason, metadata, source, created_at) are preserved for audit - this only
-- sets released_at, it does not delete or rewrite historical data.
UPDATE customer_access_holds
SET released_at = NOW()
WHERE hold_type = 'payment_risk' AND released_at IS NULL;

COMMIT;
