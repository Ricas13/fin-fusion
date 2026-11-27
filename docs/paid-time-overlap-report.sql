-- READ ONLY report: customers whose paid subscriptions overlap on one service
-- lane, and the days each lost. It changes nothing. It returns personal data
-- (name, email), so keep the output private.
--
-- Run it inside a read-only transaction:
--   BEGIN READ ONLY;
--   \i docs/paid-time-overlap-report.sql
--   ROLLBACK;
--
-- Method: per customer and lane (a bundle counts on jellyfin and stremio), a
-- row loses the part of its window already covered by earlier-starting paid
-- rows: LEAST(its end, latest earlier end) - its start. A customer total takes
-- each row once (its worst lane).
--
-- overlap_kinds:
--   recurring_over_nonrecurring  a recurring charge started over remaining
--                                one-off, migration or other non-recurring time
--   same_plan                    the same plan bought twice over itself
--   cross_plan_same_lane         a different plan on the same lane
--
-- Included: stripe, paypal, plisio and service_credit rows with a price,
-- migration rows, and zero-value promo rows. Excluded: free tier, trials,
-- add-ons, admin grants, invitations, hand-made manual rows, refunded or
-- charged-back rows, and superseded rows (only free access is superseded by
-- activations, so no paid overlap is hidden that way).
--
-- Limits, so treat totals as a lower bound to review, not as an automatic credit:
--   * The expiry job resets service_extension_days to 0. For expired rows the
--     days bought through Extend are restored from their ledger. Days an
--     administrator added to an expired row are not counted.
--   * A recurring row spans its whole agreement; starts_at can move at renewal.
--   * Rows ended early keep only their shortened end, so overlap before an
--     early ending can be missed.
--   * Overlap where one side was deliberate (an agreed upgrade or a goodwill
--     import) is still listed. Check has_permanent_access and the rows.
WITH paid AS (
  SELECT s.id, s.customer_id, s.plan_id, s.source,
         s.starts_at AS a,
         s.current_period_end + make_interval(days => GREATEST(
           COALESCE(s.service_extension_days,0),
           CASE WHEN s.status='expired' AND NOT EXISTS (
                       SELECT 1 FROM audit_log al
                       WHERE al.action='admin.prepaid.prorata_refund' AND al.entity_id=s.id::text)
                THEN COALESCE((SELECT SUM(e.applied_days)::int FROM subscription_access_extensions e
                               WHERE e.subscription_id=s.id AND e.status='active'),0)
                ELSE 0 END
         )) AS b,
         COALESCE(NULLIF(s.service_type_snapshot,''), p.service_type, 'jellyfin') AS svc,
         (s.source IN ('stripe','paypal') AND s.billing_mode='subscription') AS recurring,
         (s.source='manual') AS zero_value_promo
  FROM subscriptions s
  JOIN plans p ON p.id=s.plan_id
  WHERE COALESCE(p.is_addon,FALSE)=FALSE
    AND COALESCE(p.is_free_tier,FALSE)=FALSE
    AND COALESCE(NULLIF(s.billing_interval_snapshot,''), p.billing_interval, '') <> 'trial'
    AND (
      (s.source IN ('stripe','paypal','plisio','service_credit') AND COALESCE(s.price_minor_snapshot,p.price_minor,0)>0)
      OR s.source='migration'
      OR (s.source='manual' AND s.commercial_snapshot->>'settlementKind'='fully_discounted_local')
    )
    AND s.superseded_by IS NULL
    AND s.refund_terminated_at IS NULL
    AND s.current_period_end > s.starts_at
    AND NOT EXISTS (
      SELECT 1 FROM payment_incidents pi
      WHERE pi.provider=s.source
        AND COALESCE(s.provider_subscription_id,'')<>''
        AND BTRIM(COALESCE(pi.provider_subscription_id,''))=BTRIM(s.provider_subscription_id)
        AND (
          (pi.incident_type='chargeback' AND pi.incident_status='lost')
          OR (pi.incident_type='refund' AND pi.metadata->>'fullRefund'='true'
              AND (s.billing_mode<>'subscription' OR pi.metadata->>'currentTermLoss'='true'))
        )
    )
), laned AS (
  SELECT paid.*, lanes.lane
  FROM paid
  CROSS JOIN LATERAL unnest(CASE WHEN paid.svc='bundle' THEN ARRAY['jellyfin','stremio'] ELSE ARRAY[paid.svc] END) AS lanes(lane)
), ordered AS (
  SELECT l.*, MAX(l.b) OVER (PARTITION BY l.customer_id, l.lane ORDER BY l.a, l.b, l.id
                             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max_end
  FROM laned l
), row_loss AS (
  SELECT o.*,
         GREATEST(interval '0', LEAST(o.b,o.prev_max_end)-o.a) AS lost,
         GREATEST(interval '0', LEAST(o.b,o.prev_max_end)-GREATEST(o.a,NOW())) AS lost_still_future
  FROM ordered o
  WHERE o.prev_max_end IS NOT NULL AND o.prev_max_end>o.a
), classified AS (
  SELECT r.*,
    CASE
      WHEN r.recurring AND EXISTS (SELECT 1 FROM laned e WHERE e.customer_id=r.customer_id AND e.lane=r.lane
            AND (e.a,e.b,e.id)<(r.a,r.b,r.id) AND e.b>r.a AND NOT e.recurring) THEN 'recurring_over_nonrecurring'
      WHEN EXISTS (SELECT 1 FROM laned e WHERE e.customer_id=r.customer_id AND e.lane=r.lane
            AND (e.a,e.b,e.id)<(r.a,r.b,r.id) AND e.b>r.a AND e.plan_id=r.plan_id) THEN 'same_plan'
      ELSE 'cross_plan_same_lane'
    END AS overlap_kind
  FROM row_loss r
), per_row AS (
  SELECT id, customer_id,
         MAX(EXTRACT(EPOCH FROM lost))/86400.0 AS days_lost,
         MAX(EXTRACT(EPOCH FROM lost_still_future))/86400.0 AS days_lost_future,
         string_agg(DISTINCT lane, ',') AS lanes,
         string_agg(DISTINCT overlap_kind, ',') AS kinds,
         BOOL_OR(zero_value_promo) AS zero_value_promo
  FROM classified
  GROUP BY id, customer_id
)
SELECT c.id AS customer_id, c.display_name, c.email,
       ROUND(SUM(pr.days_lost)::numeric,2) AS total_days_lost,
       ROUND(SUM(pr.days_lost_future)::numeric,2) AS days_still_recoverable,
       COUNT(*) AS losing_rows,
       string_agg(DISTINCT pr.kinds, ',') AS overlap_kinds,
       BOOL_OR(pr.zero_value_promo) AS involves_zero_value_promo,
       EXISTS (SELECT 1 FROM customer_entitlement_overrides o
               WHERE o.customer_id=c.id AND o.permanent_access AND o.revoked_at IS NULL) AS has_permanent_access,
       jsonb_agg(jsonb_build_object('subscriptionId',pr.id,'daysLost',ROUND(pr.days_lost::numeric,2),
                 'lanes',pr.lanes,'kind',pr.kinds) ORDER BY pr.days_lost DESC) AS rows
FROM per_row pr
JOIN customers c ON c.id=pr.customer_id
WHERE pr.days_lost>=0.01
GROUP BY c.id, c.display_name, c.email
ORDER BY total_days_lost DESC;
