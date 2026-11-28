BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.billing_checkout_intents ADD COLUMN IF NOT EXISTS paid_value_transfer_snapshot jsonb;
ALTER TABLE public.subscription_time_carryovers ADD COLUMN IF NOT EXISTS value_transfer_quote jsonb;
CREATE OR REPLACE FUNCTION public.rebalance_carried_time(p_target uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  days_before bigint;
  days_after bigint;
BEGIN
  SELECT COALESCE(SUM(applied_days),0) INTO days_before FROM subscription_time_carryovers
   WHERE target_subscription_id=p_target AND status='active';

  UPDATE subscription_time_carryovers
     SET status='reversed',carried_seconds=0,applied_days=0,closed_at=NOW()
   WHERE target_subscription_id=p_target AND status='active' AND window_end<=window_start;

  -- Prepared monetary transfers have exactly one source and preserve the
  -- rational ratio rather than rounding seconds or currency before reversal.
  IF EXISTS(SELECT 1 FROM subscription_time_carryovers WHERE target_subscription_id=p_target AND status='active' AND value_transfer_quote IS NOT NULL) THEN
    UPDATE subscription_time_carryovers l
      SET carried_seconds=FLOOR(EXTRACT(EPOCH FROM (l.window_end-l.window_start)))::bigint,
          applied_days=div(
            FLOOR(EXTRACT(EPOCH FROM (l.window_end-l.window_start))*1000)*(l.value_transfer_quote->'ratio'->>'numerator')::numeric
            +86400000*(l.value_transfer_quote->'ratio'->>'denominator')::numeric-1,
            86400000*(l.value_transfer_quote->'ratio'->>'denominator')::numeric)::integer
     WHERE l.target_subscription_id=p_target AND l.status='active' AND l.value_transfer_quote IS NOT NULL;
    SELECT COALESCE(SUM(applied_days),0) INTO days_after FROM subscription_time_carryovers
     WHERE target_subscription_id=p_target AND status='active';
    RETURN (days_before-days_after)::integer;
  END IF;

  WITH uncovered AS (
    SELECT l.id,l.value_ratio,l.window_start,s.starts_at AS began,l.source_subscription_id AS source_id,
           FLOOR(GREATEST(0,EXTRACT(EPOCH FROM (l.window_end-GREATEST(l.window_start,
             MAX(l.window_end) OVER (ORDER BY l.window_start,s.starts_at,l.source_subscription_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING))))))::bigint AS seconds
      FROM subscription_time_carryovers l
      JOIN subscriptions s ON s.id=l.source_subscription_id
     WHERE l.target_subscription_id=p_target AND l.status='active'
  ), valued AS (
    SELECT uncovered.id,uncovered.seconds,uncovered.seconds*uncovered.value_ratio AS own_value,
           SUM(uncovered.seconds*uncovered.value_ratio) OVER (ORDER BY uncovered.window_start,uncovered.began,uncovered.source_id) AS running
      FROM uncovered
  )
  UPDATE subscription_time_carryovers l
     SET carried_seconds=valued.seconds,
         applied_days=(CEIL(valued.running/86400)-CEIL((valued.running-valued.own_value)/86400))::integer
    FROM valued
   WHERE l.id=valued.id;

  SELECT COALESCE(SUM(applied_days),0) INTO days_after FROM subscription_time_carryovers
   WHERE target_subscription_id=p_target AND status='active';
  RETURN (days_before-days_after)::integer;
END;
$$;
COMMIT;
