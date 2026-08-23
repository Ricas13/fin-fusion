-- Free Access is a plan policy, not a time-limited subscription.
-- Keep the existing NOT NULL timestamp contract for compatibility with the
-- entitlement engine, but use a far-future internal sentinel for live free-tier
-- subscriptions. User-facing surfaces suppress this implementation detail.

UPDATE subscriptions AS s
SET current_period_end = TIMESTAMPTZ '9999-12-31 23:59:59+00',
    service_extension_days = 0,
    updated_at = NOW()
FROM plans AS p
WHERE p.id = s.plan_id
  AND p.is_free_tier = TRUE
  AND s.superseded_by IS NULL
  AND s.status IN ('active','trialing','past_due','paused')
  AND (
      s.current_period_end <> TIMESTAMPTZ '9999-12-31 23:59:59+00'
      OR COALESCE(s.service_extension_days, 0) <> 0
  );
