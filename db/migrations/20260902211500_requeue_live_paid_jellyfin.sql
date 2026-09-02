-- Reconcile every currently-live paid/trial Jellyfin contract after the
-- paid-vs-Free entitlement precedence repair. This deliberately includes
-- customers without a Free lane as a low-risk convergence sweep: explicit
-- access holds are still honored by the canonical reconciler.
--
-- Do not filter on plans.active/visible. Catalogue state controls future sales;
-- an existing subscription contract remains an access contract.
WITH live_paid_jellyfin AS (
    SELECT DISTINCT s.customer_id
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    LEFT JOIN customer_entitlement_overrides o
      ON o.customer_id=s.customer_id AND o.subscription_id=s.id
    WHERE COALESCE(p.is_addon,FALSE)=FALSE
      AND COALESCE(p.is_free_tier,FALSE)=FALSE
      AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
      AND s.superseded_by IS NULL
      AND s.starts_at <= NOW()
      AND (
        (o.permanent_access=TRUE AND o.revoked_at IS NULL)
        OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end > NOW())
        OR (
          COALESCE(s.service_extension_days,0)>0
          AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
          AND (s.current_period_end+((s.service_extension_days||' days')::interval)) > NOW()
        )
      )
)
INSERT INTO customer_provisioning_state(
    customer_id,status,consecutive_failures,last_error,next_attempt_at,updated_at
)
SELECT customer_id,'pending',0,NULL,NOW(),NOW()
FROM live_paid_jellyfin
ON CONFLICT(customer_id) DO UPDATE SET
    status='pending',
    consecutive_failures=0,
    last_error=NULL,
    next_attempt_at=NOW(),
    updated_at=NOW();
