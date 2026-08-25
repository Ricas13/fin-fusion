-- Treat repeated provider retries for one invoice as one operational case.
-- Also retire historical failed-renewal incidents once Stripe has confirmed
-- that the underlying subscription is cancelled.

WITH terminal_stripe_subscriptions AS (
    SELECT DISTINCT payload #>> '{data,object,id}' AS provider_subscription_id
    FROM payment_events
    WHERE provider='stripe'
      AND event_type='customer.subscription.deleted'
      AND processed_at IS NOT NULL
      AND COALESCE(payload #>> '{data,object,id}','') <> ''
)
UPDATE payment_incidents pi
SET incident_status='resolved',
    resolved_at=COALESCE(pi.resolved_at,NOW()),
    resolution_note=COALESCE(
        pi.resolution_note,
        'Stripe subscription ended after the failed renewal; no operator action remains.'
    ),
    updated_at=NOW()
FROM terminal_stripe_subscriptions t
WHERE pi.provider='stripe'
  AND pi.incident_type='failed_renewal'
  AND pi.incident_status='open'
  AND pi.provider_subscription_id=t.provider_subscription_id;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY provider,provider_case_id,incident_type
               ORDER BY created_at,id
           ) AS retry_rank
    FROM payment_incidents
    WHERE incident_type='failed_renewal'
      AND incident_status='open'
      AND provider_case_id IS NOT NULL
)
UPDATE payment_incidents pi
SET incident_status='resolved',
    resolved_at=COALESCE(pi.resolved_at,NOW()),
    resolution_note=COALESCE(
        pi.resolution_note,
        'Consolidated duplicate provider retry for the same failed renewal invoice.'
    ),
    updated_at=NOW()
FROM ranked r
WHERE pi.id=r.id
  AND r.retry_rank>1;

CREATE UNIQUE INDEX IF NOT EXISTS payment_incidents_one_open_failed_renewal_case
    ON payment_incidents(provider,provider_case_id,incident_type)
    WHERE provider_case_id IS NOT NULL
      AND incident_type='failed_renewal'
      AND incident_status='open';
