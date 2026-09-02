-- Reconcile customers that can hold Free Server and Premium Jellyfin in parallel.
--
-- Before the runtime selector was fixed, the year-9999 Free entitlement could
-- win over a live paid/trial Jellyfin entitlement. Reconciliation then disabled
-- the primary/Premium account and still marked the customer healthy because the
-- Free lane remained active. Requeue every customer with both live lanes so a
-- deploy self-heals that historical wrong desired state without waiting for an
-- operator to click Reconcile.

WITH affected AS (
    SELECT DISTINCT paid.customer_id
    FROM subscriptions paid
    JOIN plans paid_plan ON paid_plan.id=paid.plan_id
    LEFT JOIN customer_entitlement_overrides paid_override
           ON paid_override.customer_id=paid.customer_id
          AND paid_override.subscription_id=paid.id
    JOIN subscriptions free_sub ON free_sub.customer_id=paid.customer_id
    JOIN plans free_plan ON free_plan.id=free_sub.plan_id
    LEFT JOIN customer_entitlement_overrides free_override
           ON free_override.customer_id=free_sub.customer_id
          AND free_override.subscription_id=free_sub.id
    WHERE COALESCE(paid_plan.is_free_tier,FALSE)=FALSE
      AND COALESCE(paid_plan.is_addon,FALSE)=FALSE
      AND COALESCE(NULLIF(paid.service_type_snapshot,''),paid_plan.service_type,'jellyfin') IN ('jellyfin','bundle')
      AND paid.superseded_by IS NULL
      AND paid.starts_at<=NOW()
      AND (
          (paid_override.permanent_access=TRUE AND paid_override.revoked_at IS NULL)
          OR (paid.status IN ('active','trialing','past_due','paused') AND paid.current_period_end>NOW())
          OR (
              COALESCE(paid.service_extension_days,0)>0
              AND paid.status IN ('active','trialing','past_due','paused','cancelled','expired')
              AND paid.current_period_end+((paid.service_extension_days||' days')::interval)>NOW()
          )
      )
      AND free_plan.is_free_tier=TRUE
      AND COALESCE(free_plan.is_addon,FALSE)=FALSE
      AND COALESCE(NULLIF(free_sub.service_type_snapshot,''),free_plan.service_type,'jellyfin') IN ('jellyfin','bundle')
      AND free_sub.superseded_by IS NULL
      AND free_sub.starts_at<=NOW()
      AND (
          (free_override.permanent_access=TRUE AND free_override.revoked_at IS NULL)
          OR (free_sub.status IN ('active','trialing','past_due','paused') AND free_sub.current_period_end>NOW())
          OR (
              COALESCE(free_sub.service_extension_days,0)>0
              AND free_sub.status IN ('active','trialing','past_due','paused','cancelled','expired')
              AND free_sub.current_period_end+((free_sub.service_extension_days||' days')::interval)>NOW()
          )
      )
)
INSERT INTO customer_provisioning_state(customer_id,status,next_attempt_at,updated_at)
SELECT customer_id,'pending',NOW(),NOW()
FROM affected
ON CONFLICT (customer_id) DO UPDATE SET
    status='pending',
    next_attempt_at=NOW(),
    last_error=NULL,
    updated_at=NOW();
