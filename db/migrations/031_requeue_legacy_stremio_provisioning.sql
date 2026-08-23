-- Requeue failures left behind by the retired Stremio delivery model.
-- Current Stremio entitlements can be source-based and do not require a
-- customer-facing Jellyfin account. The service-aware reconciler will rebuild
-- the authoritative state on the next automation pass.

UPDATE customer_provisioning_state cps
SET status='pending',
    consecutive_failures=0,
    last_error=NULL,
    next_attempt_at=NOW(),
    updated_at=NOW()
WHERE cps.status IN ('failed','blocked')
  AND cps.last_error LIKE '%Active Stremio entitlement requires either selected shared sources or a managed Jellyfin delivery identity%'
  AND EXISTS (
    SELECT 1
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    WHERE s.customer_id=cps.customer_id
      AND s.superseded_by IS NULL
      AND s.status IN ('active','trialing','past_due','paused')
      AND s.current_period_end>NOW()
      AND p.active=TRUE
      AND p.service_type='stremio'
  );
