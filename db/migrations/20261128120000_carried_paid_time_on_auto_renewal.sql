BEGIN;

-- Additive only: one new table plus new or replaced functions. Nothing alters
-- an existing table or trigger. Give up quickly rather than queue behind (and in
-- front of) live traffic if a catalog lock is unavailable.
SET LOCAL lock_timeout = '5s';

-- A payment always adds time. When a new auto-renewing agreement is bought over
-- paid time of identical access, the remaining time moves onto the new row as
-- service_extension_days and the old row is superseded. This ledger records
-- exactly what moved, so a refund can take back what was refunded and no more.
-- Rolling-compatible: the previous web generation sees ordinary extension days
-- on the receiving row and ordinary superseded source rows.
CREATE TABLE IF NOT EXISTS public.subscription_time_carryovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  target_subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  source_subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  source_provider text NOT NULL,
  source_payment_ref text,
  -- The part of the source's access still carried, as it stood when carried.
  -- Refunds shorten it. Windows of different sources may overlap.
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  -- What this row adds to the union of the receiving row's windows: time no
  -- earlier window already covers, in the source's own units. May be zero.
  carried_seconds bigint NOT NULL CHECK (carried_seconds>=0),
  -- Days that adds to the receiving row. The total is rounded once, so this may
  -- be zero for a row that adds less than the rounding already granted.
  applied_days integer NOT NULL CHECK (applied_days>=0),
  -- 1 today. Converting between plans by value may give more or fewer days.
  value_ratio numeric NOT NULL DEFAULT 1 CHECK (value_ratio>0),
  -- The receiving row's first paid-through date, to tell a refund of the first
  -- payment from a refund of a later renewal.
  target_first_period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reversed','returned')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  closed_at timestamptz
);

DO $indexes$
BEGIN
  IF to_regclass('public.subscription_time_carryovers_active_source') IS NULL THEN
    CREATE UNIQUE INDEX subscription_time_carryovers_active_source
      ON public.subscription_time_carryovers(source_subscription_id) WHERE status='active';
  END IF;
  IF to_regclass('public.subscription_time_carryovers_target') IS NULL THEN
    CREATE INDEX subscription_time_carryovers_target
      ON public.subscription_time_carryovers(target_subscription_id);
  END IF;
  IF to_regclass('public.subscription_time_carryovers_customer') IS NULL THEN
    CREATE INDEX subscription_time_carryovers_customer
      ON public.subscription_time_carryovers(customer_id);
  END IF;
END
$indexes$;

-- Paid time a customer holds with exactly this access. Plan and billing period
-- may differ. Trials, free access, invitations, add-ons, refunded and replaced
-- rows are not in it. An auto-renewing agreement is in it only once it has ended
-- at the provider and lives on its extension days: a live one still blocks a
-- second agreement, so nothing could be carried from it.
-- Lifetime access is returned flagged, with nothing to carry.
CREATE OR REPLACE FUNCTION public.carryable_paid_time(
  p_customer uuid,p_service text,p_server_class text,p_streams integer,p_households integer,p_exclude uuid DEFAULT NULL
)
RETURNS TABLE(subscription_id uuid,source text,provider_subscription_id text,starts_at timestamptz,access_end timestamptz,carried_seconds bigint,lifetime boolean)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT s.id,s.source,s.provider_subscription_id,s.starts_at,held.access_end,
         CASE WHEN held.permanent OR s.current_period_end>=NOW()+INTERVAL '20 years' THEN NULL
              ELSE FLOOR(EXTRACT(EPOCH FROM (held.access_end-GREATEST(NOW(),s.starts_at))))::bigint END,
         (held.permanent OR s.current_period_end>=NOW()+INTERVAL '20 years')
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    CROSS JOIN LATERAL (
      SELECT s.current_period_end+((COALESCE(s.service_extension_days,0)||' days')::interval) AS access_end,
             public.prepaid_row_is_recurring(s.source,s.provider_subscription_id,s.billing_mode) AS recurring,
             EXISTS(
               SELECT 1 FROM customer_entitlement_overrides o
                WHERE o.customer_id=s.customer_id AND o.subscription_id=s.id
                  AND o.permanent_access=TRUE AND o.revoked_at IS NULL
             ) AS permanent
    ) held
   WHERE s.customer_id=p_customer
     AND s.id IS DISTINCT FROM p_exclude
     AND s.superseded_by IS NULL
     AND s.refund_terminated_at IS NULL
     AND s.source IN ('stripe','paypal','plisio','migration','service_credit','manual','admin_grant')
     AND COALESCE(p.is_addon,FALSE)=FALSE
     AND COALESCE(p.is_free_tier,FALSE)=FALSE
     AND COALESCE(NULLIF(s.billing_interval_snapshot,''),p.billing_interval,'')<>'trial'
     AND s.status<>'trialing'
     AND (
       held.permanent
       OR (
         held.access_end>NOW()
         AND CASE WHEN held.recurring
               THEN s.cancel_at_period_end AND s.status IN ('cancelled','expired') AND COALESCE(s.service_extension_days,0)>0
               ELSE s.status='active' OR (s.status IN ('cancelled','expired') AND COALESCE(s.service_extension_days,0)>0)
             END
       )
     )
     -- Identical access, never merely "no more than".
     AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin')=p_service
     AND COALESCE(NULLIF(s.commercial_snapshot->>'serverClass',''),p.server_class) IS NOT DISTINCT FROM p_server_class
     AND (
       p_service='stremio'
       OR COALESCE(CASE WHEN s.commercial_snapshot->>'streams' ~ '^[0-9]{1,4}$' THEN (s.commercial_snapshot->>'streams')::integer END,p.streams)
          IS NOT DISTINCT FROM p_streams
     )
     AND (
       p_service NOT IN ('stremio','bundle')
       OR COALESCE(CASE WHEN s.commercial_snapshot->>'stremioHouseholdNetworkLimit' ~ '^[0-9]{1,4}$' THEN (s.commercial_snapshot->>'stremioHouseholdNetworkLimit')::integer END,s.stremio_household_network_limit_snapshot,p.stremio_household_network_limit)
          IS NOT DISTINCT FROM p_households
     )
     -- Money already taken back is not paid time.
     AND NOT EXISTS(
       SELECT 1 FROM payment_incidents pi
        WHERE pi.provider=s.source
          AND pi.provider_subscription_id=s.provider_subscription_id
          AND (
            (pi.incident_type='chargeback' AND pi.incident_status='lost')
            OR (pi.incident_type='refund' AND COALESCE(pi.metadata->>'fullRefund','false')='true'
                AND (NOT held.recurring OR COALESCE(pi.metadata->>'currentTermLoss','false')='true'))
          )
     )
$$;

-- What could be carried onto this receiving row now. Read only, so it is also
-- the preview for a later repair. Nothing is returned unless the row is a paid,
-- confirmed auto-renewing agreement.
CREATE OR REPLACE FUNCTION public.carry_candidates(p_target uuid)
RETURNS TABLE(subscription_id uuid,source text,provider_subscription_id text,starts_at timestamptz,access_end timestamptz,carried_seconds bigint,lifetime boolean)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT held.*
    FROM subscriptions t
    JOIN plans p ON p.id=t.plan_id
    CROSS JOIN LATERAL public.carryable_paid_time(
      t.customer_id,
      COALESCE(NULLIF(t.service_type_snapshot,''),p.service_type,'jellyfin'),
      COALESCE(NULLIF(t.commercial_snapshot->>'serverClass',''),p.server_class),
      COALESCE(CASE WHEN t.commercial_snapshot->>'streams' ~ '^[0-9]{1,4}$' THEN (t.commercial_snapshot->>'streams')::integer END,p.streams),
      COALESCE(CASE WHEN t.commercial_snapshot->>'stremioHouseholdNetworkLimit' ~ '^[0-9]{1,4}$' THEN (t.commercial_snapshot->>'stremioHouseholdNetworkLimit')::integer END,t.stremio_household_network_limit_snapshot,p.stremio_household_network_limit),
      t.id
    ) held
   WHERE t.id=p_target
     AND t.status='active'
     AND t.superseded_by IS NULL
     AND t.refund_terminated_at IS NULL
     AND t.current_period_end>NOW()
     AND public.prepaid_row_is_recurring(t.source,t.provider_subscription_id,t.billing_mode)
     AND COALESCE(p.is_addon,FALSE)=FALSE
     AND COALESCE(p.is_free_tier,FALSE)=FALSE
     AND COALESCE(NULLIF(t.billing_interval_snapshot,''),p.billing_interval,'')<>'trial'
$$;

-- The same question before money is taken, when there is no receiving row yet.
CREATE OR REPLACE FUNCTION public.carried_time_precheck(p_customer uuid,p_plan uuid,p_snapshot jsonb)
RETURNS TABLE(lifetime boolean,total_days bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH held AS (
    SELECT c.lifetime AS forever,GREATEST(NOW(),c.starts_at) AS window_start,c.access_end AS window_end,
           c.starts_at AS began,c.subscription_id AS source_id
      FROM plans bought
      CROSS JOIN LATERAL public.carryable_paid_time(
        p_customer,
        COALESCE(bought.service_type,'jellyfin'),
        COALESCE(NULLIF(p_snapshot->>'serverClass',''),bought.server_class),
        COALESCE(CASE WHEN p_snapshot->>'streams' ~ '^[0-9]{1,4}$' THEN (p_snapshot->>'streams')::integer END,bought.streams),
        COALESCE(CASE WHEN p_snapshot->>'stremioHouseholdNetworkLimit' ~ '^[0-9]{1,4}$' THEN (p_snapshot->>'stremioHouseholdNetworkLimit')::integer END,bought.stremio_household_network_limit),
        NULL
      ) c
     WHERE bought.id=p_plan
       AND COALESCE(bought.is_addon,FALSE)=FALSE
       AND COALESCE(bought.is_free_tier,FALSE)=FALSE
       AND COALESCE(bought.billing_interval,'')<>'trial'
  ), uncovered AS (
    -- The union of the held windows, exactly as carrying would count it.
    SELECT FLOOR(GREATEST(0,EXTRACT(EPOCH FROM (held.window_end-GREATEST(held.window_start,
             MAX(held.window_end) OVER (ORDER BY held.window_start,held.began,held.source_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)))))) AS seconds
      FROM held
     WHERE NOT held.forever AND held.window_end>held.window_start
  )
  SELECT (SELECT COALESCE(BOOL_OR(held.forever),FALSE) FROM held),
         (SELECT CEIL(COALESCE(SUM(uncovered.seconds),0)/86400)::bigint FROM uncovered)
$$;

-- The days the receiving row's carried windows would be worth with one more
-- window added: the union, rounded up once. Read only.
CREATE OR REPLACE FUNCTION public.carried_time_total_days(
  p_target uuid,p_source uuid,p_from timestamptz,p_to timestamptz,p_ratio numeric
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH windows AS (
    SELECT l.window_start,l.window_end,l.value_ratio AS ratio,s.starts_at AS began,l.source_subscription_id AS source_id
      FROM subscription_time_carryovers l
      JOIN subscriptions s ON s.id=l.source_subscription_id
     WHERE l.target_subscription_id=p_target AND l.status='active' AND l.window_end>l.window_start
    UNION ALL
    SELECT p_from,p_to,p_ratio,s.starts_at,s.id FROM subscriptions s WHERE s.id=p_source
  ), uncovered AS (
    SELECT windows.ratio,
           FLOOR(GREATEST(0,EXTRACT(EPOCH FROM (windows.window_end-GREATEST(windows.window_start,
             MAX(windows.window_end) OVER (ORDER BY windows.window_start,windows.began,windows.source_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)))))) AS seconds
      FROM windows
  )
  SELECT CEIL(COALESCE(SUM(uncovered.seconds*uncovered.ratio),0)/86400) FROM uncovered
$$;

-- Recount every active window of a receiving row. Each source adds only the time
-- no earlier one covers, so time held once is granted once, and the days are
-- shared out so that their total is the union rounded up once. A window with
-- nothing left is closed. Returns the days the receiving row should lose
-- (negative: gain). The caller holds the customer lock and applies the change.
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

-- Move one source's remaining time onto a receiving row. Callable on its own.
-- Returns the days added (0 when other carried time already covers all of it),
-- NULL when the source is not eligible, and -1 when it would exceed the
-- 3,650-day limit (the source is then left exactly as it was). It never refuses
-- a paid activation by raising.
CREATE OR REPLACE FUNCTION public.carry_paid_time(
  p_target uuid,p_source uuid,p_ratio numeric DEFAULT 1,p_reason text DEFAULT 'auto_renew_purchase'
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  owner_id uuid;
  receiving subscriptions%ROWTYPE;
  donor subscriptions%ROWTYPE;
  candidate record;
  window_from timestamptz;
  days_before bigint;
  days_after numeric;
  days integer;
BEGIN
  SELECT s.customer_id INTO owner_id FROM subscriptions s WHERE s.id=p_target;
  IF owner_id IS NULL OR p_ratio IS NULL OR p_ratio<=0 THEN
    RETURN NULL;
  END IF;

  -- One lock order everywhere: the customer, the stacking lock, subscriptions.
  PERFORM 1 FROM customers WHERE id=owner_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  SELECT * INTO receiving FROM subscriptions WHERE id=p_target FOR UPDATE;
  SELECT * INTO donor FROM subscriptions WHERE id=p_source AND customer_id=owner_id FOR UPDATE;
  IF donor.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO candidate FROM public.carry_candidates(p_target) c WHERE c.subscription_id=p_source;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  window_from:=GREATEST(NOW(),candidate.starts_at);
  IF candidate.lifetime OR candidate.access_end<=window_from THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(applied_days),0) INTO days_before FROM subscription_time_carryovers
   WHERE target_subscription_id=p_target AND status='active';
  days_after:=public.carried_time_total_days(p_target,p_source,window_from,candidate.access_end,p_ratio);
  IF COALESCE(receiving.service_extension_days,0)+(days_after-days_before)>3650 THEN
    RETURN -1;
  END IF;

  INSERT INTO subscription_time_carryovers(
    customer_id,target_subscription_id,source_subscription_id,source_provider,source_payment_ref,
    window_start,window_end,carried_seconds,applied_days,value_ratio,target_first_period_end,reason
  ) VALUES(
    owner_id,p_target,p_source,donor.source,donor.provider_subscription_id,
    window_from,candidate.access_end,0,0,p_ratio,receiving.current_period_end,p_reason
  );
  days:=-public.rebalance_carried_time(p_target);

  UPDATE subscriptions
     SET superseded_by=p_target,replaced_at=NOW(),replacement_reason='paid_time_carried',updated_at=NOW()
   WHERE id=p_source;

  -- The customer keeps the server they already occupy unless the new purchase
  -- chose a placement of its own.
  UPDATE subscriptions
     SET service_extension_days=GREATEST(0,COALESCE(service_extension_days,0)+days),
         media_server_id=CASE
           WHEN media_server_id IS NULL AND NULLIF(media_location_snapshot,'') IS NULL AND donor.starts_at<=NOW()
           THEN donor.media_server_id ELSE media_server_id END,
         media_location_preference=CASE
           WHEN media_server_id IS NULL AND NULLIF(media_location_snapshot,'') IS NULL AND donor.starts_at<=NOW()
           THEN COALESCE(donor.media_location_snapshot,media_location_preference) ELSE media_location_preference END,
         media_location_snapshot=CASE
           WHEN media_server_id IS NULL AND NULLIF(media_location_snapshot,'') IS NULL AND donor.starts_at<=NOW()
           THEN donor.media_location_snapshot ELSE media_location_snapshot END,
         updated_at=NOW()
   WHERE id=p_target;

  INSERT INTO audit_log(action,entity_type,entity_id,metadata)
  VALUES('subscription.paid_time.carried','subscription',p_target::text,jsonb_build_object(
    'customerId',owner_id,'sourceSubscriptionId',p_source,'windowStart',window_from,'windowEnd',candidate.access_end,
    'addedDays',days,'valueRatio',p_ratio,'reason',p_reason));

  RETURN GREATEST(days,0);
END;
$$;

-- Everything the receiving row's purchase should carry, once. A replay finds the
-- ledger rows and does nothing. p_ratios maps a source id to its value ratio.
CREATE OR REPLACE FUNCTION public.carry_all_paid_time(
  p_target uuid,p_ratios jsonb DEFAULT '{}'::jsonb,p_reason text DEFAULT 'auto_renew_purchase'
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  owner_id uuid;
  receiving subscriptions%ROWTYPE;
  source_ids uuid[];
  source_id uuid;
  days integer;
  total integer:=0;
  carried jsonb:='[]'::jsonb;
  skipped jsonb:='[]'::jsonb;
BEGIN
  SELECT s.customer_id INTO owner_id FROM subscriptions s WHERE s.id=p_target;
  IF owner_id IS NULL THEN
    RETURN jsonb_build_object('days',0,'carried',carried,'skipped',skipped);
  END IF;
  PERFORM 1 FROM customers WHERE id=owner_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text,0));

  IF EXISTS(SELECT 1 FROM subscription_time_carryovers l WHERE l.target_subscription_id=p_target) THEN
    RETURN jsonb_build_object('days',0,'carried',carried,'skipped',skipped,'already',TRUE);
  END IF;

  -- A paid agreement whose recorded period has already ended can receive
  -- nothing. Say so when there is time that should have been added to it.
  SELECT * INTO receiving FROM subscriptions WHERE id=p_target FOR UPDATE;
  IF receiving.status='active' AND receiving.current_period_end<=NOW()
     AND receiving.superseded_by IS NULL AND receiving.refund_terminated_at IS NULL
     AND public.prepaid_row_is_recurring(receiving.source,receiving.provider_subscription_id,receiving.billing_mode)
     AND EXISTS(
       SELECT 1 FROM public.carried_time_precheck(owner_id,receiving.plan_id,receiving.commercial_snapshot) held
        WHERE held.total_days>0
     ) THEN
    RETURN jsonb_build_object('days',0,'carried',carried,'skipped',skipped,'ineligible','receiving_period_ended');
  END IF;

  SELECT ARRAY_AGG(c.subscription_id ORDER BY c.starts_at,c.subscription_id)
    INTO source_ids FROM public.carry_candidates(p_target) c;

  FOREACH source_id IN ARRAY COALESCE(source_ids,ARRAY[]::uuid[]) LOOP
    days:=public.carry_paid_time(p_target,source_id,COALESCE((p_ratios->>source_id::text)::numeric,1),p_reason);
    IF days>=0 THEN
      total:=total+days;
      carried:=carried||jsonb_build_object('subscriptionId',source_id,'days',days);
    ELSE
      skipped:=skipped||jsonb_build_object('subscriptionId',source_id,'reason',CASE WHEN days IS NULL THEN 'not_carried' ELSE 'over_limit' END);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('days',total,'carried',carried,'skipped',skipped);
END;
$$;

-- Apply a recount to the row holding the time, following carried time that has
-- since moved on again. Separately bought extension days are never removed, and
-- an ended row is never given days. The caller holds the customer lock.
CREATE OR REPLACE FUNCTION public.apply_carried_change(p_target uuid,p_lost_days integer)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  holder uuid:=p_target;
  lost integer:=COALESCE(p_lost_days,0);
  held subscriptions%ROWTYPE;
  previous integer;
  updated integer;
  bought bigint;
  onward subscription_time_carryovers%ROWTYPE;
BEGIN
  FOR step IN 1..100 LOOP
    EXIT WHEN lost=0;
    SELECT * INTO held FROM subscriptions WHERE id=holder FOR UPDATE;
    EXIT WHEN NOT FOUND;
    previous:=COALESCE(held.service_extension_days,0);
    SELECT COALESCE(SUM(applied_days),0) INTO bought
      FROM subscription_access_extensions WHERE subscription_id=holder AND status='active';
    updated:=previous;
    IF lost>0 THEN
      updated:=GREATEST(LEAST(previous,bought)::integer,previous-lost);
    ELSIF held.refund_terminated_at IS NULL THEN
      updated:=LEAST(3650,previous-lost);
    END IF;
    IF updated<>previous THEN
      UPDATE subscriptions SET service_extension_days=updated,updated_at=NOW() WHERE id=holder;
      PERFORM public.shift_prepaid_queue_after_end_change(holder,previous);
    END IF;

    SELECT * INTO onward FROM subscription_time_carryovers
     WHERE source_subscription_id=holder AND status='active' FOR UPDATE;
    EXIT WHEN NOT FOUND;
    -- Carried days sit at the end of the holder's access.
    UPDATE subscription_time_carryovers
       SET window_end=GREATEST(window_start,window_end-((lost::bigint*86400)*INTERVAL '1 second'))
     WHERE id=onward.id;
    lost:=public.rebalance_carried_time(onward.target_subscription_id);
    holder:=onward.target_subscription_id;
  END LOOP;
  RETURN holder;
END;
$$;

-- The source's own payment was lost (full refund or lost chargeback): its own
-- time stops counting, once. Time carried into the source from other payments,
-- extensions bought on it, and whatever other carried sources still cover all
-- stay. Returns the days taken back, or NULL when nothing is carried from it.
CREATE OR REPLACE FUNCTION public.reverse_carried_paid_time(p_source uuid,p_reason text DEFAULT 'source_payment_lost')
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  owner_id uuid;
  entry subscription_time_carryovers%ROWTYPE;
  keep bigint;
  removed integer;
BEGIN
  SELECT customer_id INTO owner_id FROM subscription_time_carryovers
   WHERE source_subscription_id=p_source AND status='active';
  IF owner_id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM customers WHERE id=owner_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  SELECT * INTO entry FROM subscription_time_carryovers
   WHERE source_subscription_id=p_source AND status='active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Days on the source that its lost payment did not buy. They end its access.
  SELECT COALESCE((SELECT SUM(e.applied_days) FROM subscription_access_extensions e
                    WHERE e.subscription_id=p_source AND e.status='active'),0)
        +COALESCE((SELECT SUM(l.applied_days) FROM subscription_time_carryovers l
                    WHERE l.target_subscription_id=p_source AND l.status='active'),0)
    INTO keep;
  UPDATE subscription_time_carryovers
     SET window_start=GREATEST(window_start,window_end-((keep*86400)*INTERVAL '1 second')),reason=p_reason
   WHERE id=entry.id;
  removed:=public.rebalance_carried_time(entry.target_subscription_id);
  PERFORM public.apply_carried_change(entry.target_subscription_id,removed);
  UPDATE subscriptions SET refund_terminated_at=COALESCE(refund_terminated_at,NOW()),updated_at=NOW()
   WHERE id=p_source;

  INSERT INTO audit_log(action,entity_type,entity_id,metadata)
  VALUES('subscription.paid_time.reversed','subscription',entry.target_subscription_id::text,jsonb_build_object(
    'customerId',owner_id,'sourceSubscriptionId',p_source,'removedDays',removed,'separatelyHeldDays',keep,'reason',p_reason));
  RETURN removed;
END;
$$;

-- By provider reference. An ended auto-renewing source loses its carried time
-- only when the lost money paid for its current term.
CREATE OR REPLACE FUNCTION public.reverse_carried_paid_time_by_payment(
  p_provider text,p_reference text,p_current_term boolean,p_reason text DEFAULT 'source_payment_lost'
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  source_id uuid;
  reversed integer:=0;
BEGIN
  FOR source_id IN
    SELECT s.id FROM subscriptions s
      JOIN subscription_time_carryovers l ON l.source_subscription_id=s.id AND l.status='active'
     WHERE s.source=p_provider AND s.provider_subscription_id=p_reference
       AND (COALESCE(p_current_term,FALSE) OR NOT public.prepaid_row_is_recurring(s.source,s.provider_subscription_id,s.billing_mode))
     ORDER BY s.id
  LOOP
    IF public.reverse_carried_paid_time(source_id,p_reason) IS NOT NULL THEN
      reversed:=reversed+1;
    END IF;
  END LOOP;
  RETURN reversed;
END;
$$;

-- Part of a carried source was refunded (pro-rata), or an extension bought on it
-- was reversed: take exactly that span out of its window. A base refund comes
-- off the front, so extension days at the end stay; an extension reversal comes
-- off the end. p_base_payment skips a source whose base payment loss has already
-- been applied. Returns the days removed from the receiving row.
CREATE OR REPLACE FUNCTION public.reduce_carried_paid_time(
  p_source uuid,p_removed_seconds numeric,p_base_payment boolean,p_reason text DEFAULT 'source_partially_refunded'
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  owner_id uuid;
  entry subscription_time_carryovers%ROWTYPE;
  refunded_at timestamptz;
  span interval;
  removed integer;
BEGIN
  SELECT customer_id INTO owner_id FROM subscription_time_carryovers
   WHERE source_subscription_id=p_source AND status='active';
  IF owner_id IS NULL OR COALESCE(p_removed_seconds,0)<=0 THEN
    RETURN 0;
  END IF;
  PERFORM 1 FROM customers WHERE id=owner_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  SELECT refund_terminated_at INTO refunded_at FROM subscriptions WHERE id=p_source FOR UPDATE;
  IF p_base_payment AND refunded_at IS NOT NULL THEN
    RETURN 0;
  END IF;
  SELECT * INTO entry FROM subscription_time_carryovers
   WHERE source_subscription_id=p_source AND status='active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  span:=CEIL(p_removed_seconds)::double precision*INTERVAL '1 second';
  IF p_base_payment THEN
    UPDATE subscription_time_carryovers
       SET window_start=LEAST(window_end,window_start+span),reason=p_reason
     WHERE id=entry.id;
  ELSE
    UPDATE subscription_time_carryovers
       SET window_end=GREATEST(window_start,window_end-span),reason=p_reason
     WHERE id=entry.id;
  END IF;
  removed:=public.rebalance_carried_time(entry.target_subscription_id);
  PERFORM public.apply_carried_change(entry.target_subscription_id,removed);
  INSERT INTO audit_log(action,entity_type,entity_id,metadata)
  VALUES('subscription.paid_time.reduced','subscription',entry.target_subscription_id::text,jsonb_build_object(
    'customerId',owner_id,'sourceSubscriptionId',p_source,'removedDays',removed,'reason',p_reason));
  RETURN removed;
END;
$$;

-- The receiving row's payment is being taken back. While it is still in its
-- first paid term the sources come back exactly as they were ('returned'). After
-- a renewal the carried days are still owed: nothing is granted automatically
-- and the caller records an operator incident ('owed'). 'none': nothing carried.
CREATE OR REPLACE FUNCTION public.return_carried_paid_time(p_target uuid,p_reason text DEFAULT 'first_payment_lost')
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  owner_id uuid;
  receiving subscriptions%ROWTYPE;
  first_end timestamptz;
  entry subscription_time_carryovers%ROWTYPE;
  total integer:=0;
  previous integer;
  bought bigint;
BEGIN
  SELECT customer_id INTO owner_id FROM subscription_time_carryovers
   WHERE target_subscription_id=p_target AND status='active' LIMIT 1;
  IF owner_id IS NULL THEN
    RETURN 'none';
  END IF;
  PERFORM 1 FROM customers WHERE id=owner_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  SELECT * INTO receiving FROM subscriptions WHERE id=p_target FOR UPDATE;
  -- A receiving row that has since been carried on is a source: its own refund
  -- goes through reverse_carried_paid_time.
  IF receiving.superseded_by IS NOT NULL THEN
    RETURN 'none';
  END IF;
  SELECT MIN(target_first_period_end) INTO first_end FROM subscription_time_carryovers
   WHERE target_subscription_id=p_target AND status='active';
  IF first_end IS NULL THEN
    RETURN 'none';
  END IF;
  IF NOW()>=first_end OR receiving.current_period_end>first_end+INTERVAL '2 days' THEN
    RETURN 'owed';
  END IF;

  FOR entry IN
    SELECT * FROM subscription_time_carryovers
     WHERE target_subscription_id=p_target AND status='active'
     ORDER BY created_at,id FOR UPDATE
  LOOP
    UPDATE subscription_time_carryovers SET status='returned',reason=p_reason,closed_at=NOW() WHERE id=entry.id;
    -- The source's own window was never changed.
    UPDATE subscriptions
       SET superseded_by=NULL,replaced_at=NULL,replacement_reason=NULL,updated_at=NOW()
     WHERE id=entry.source_subscription_id AND superseded_by=p_target;
    total:=total+entry.applied_days;
  END LOOP;

  previous:=COALESCE(receiving.service_extension_days,0);
  SELECT COALESCE(SUM(applied_days),0) INTO bought
    FROM subscription_access_extensions WHERE subscription_id=p_target AND status='active';
  IF previous>0 AND total>0 THEN
    UPDATE subscriptions
       SET service_extension_days=GREATEST(LEAST(previous,bought)::integer,previous-total),updated_at=NOW()
     WHERE id=p_target;
    PERFORM public.shift_prepaid_queue_after_end_change(p_target,previous);
  END IF;

  INSERT INTO audit_log(action,entity_type,entity_id,metadata)
  VALUES('subscription.paid_time.returned','subscription',p_target::text,jsonb_build_object(
    'customerId',owner_id,'returnedDays',total,'reason',p_reason));
  RETURN 'returned';
END;
$$;

-- As 20260905010000, with one exception: an unpaid renewal does not block the
-- paid-for extension days. They run from the end of the last paid term, which is
-- the earlier of the recorded period end and the moment the hold was raised, so
-- the rule holds whether or not the provider moved the period end first. Keep
-- this without a SET clause; it is evaluated per row inside views.
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
              END
              AND NOT EXISTS (
                  SELECT 1 FROM public.subscriptions s
                   WHERE s.source=p_source
                     AND s.provider_subscription_id=p_provider_subscription_id
                     AND s.customer_id=p_customer_id
                     AND s.superseded_by IS NULL
                     AND s.refund_terminated_at IS NULL
                     AND s.service_extension_days>0
                     AND NOW() < LEAST(h.created_at,s.current_period_end)+((s.service_extension_days||' days')::interval)
              ))
              OR (h.hold_type IN ('inactivity_policy','jellyfin_cleanup') AND p_source='free_claim')
              OR h.hold_type NOT IN ('payment_delinquency','inactivity_policy','jellyfin_cleanup','payment_risk')
          )
    );
$$;

-- As 20261127150000, preceded by the carried-time reversal. It runs in the
-- database so that a web process which predates carried time cannot leave
-- refunded or charged-back time on the receiving row.
CREATE OR REPLACE FUNCTION reconcile_future_prepaid_full_refund()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refunded subscriptions%ROWTYPE;
  refunded_service text;
  removed_seconds numeric;
BEGIN
  IF NEW.provider_subscription_id IS NOT NULL THEN
    IF NEW.incident_type='chargeback' AND NEW.incident_status='lost' THEN
      PERFORM public.reverse_carried_paid_time_by_payment(NEW.provider,NEW.provider_subscription_id,TRUE,'source_chargeback_lost');
    ELSIF NEW.incident_type='refund' AND COALESCE((NEW.metadata->>'fullRefund')::boolean,FALSE) THEN
      PERFORM public.reverse_carried_paid_time_by_payment(NEW.provider,NEW.provider_subscription_id,
        COALESCE(NEW.metadata->>'currentTermLoss','false')='true','source_refunded');
    END IF;
  END IF;

  IF NEW.incident_type <> 'refund' OR COALESCE((NEW.metadata->>'fullRefund')::boolean,FALSE) IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF NEW.provider_subscription_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.provider='stripe' AND NEW.provider_subscription_id ~* '^sub_')
     OR (NEW.provider='paypal' AND NEW.provider_subscription_id ~* '^I-') THEN
    RETURN NEW;
  END IF;

  -- One lock order everywhere: the customer, then the subscription. Already
  -- held since the before-insert guard below ran; repeated so that this function
  -- does not depend on it.
  PERFORM 1 FROM customers
   WHERE id=(
     SELECT s.customer_id FROM subscriptions s
      WHERE s.source=NEW.provider
        AND s.provider_subscription_id=NEW.provider_subscription_id
        AND s.superseded_by IS NULL
        AND s.starts_at>NOW()
      ORDER BY s.created_at DESC
      LIMIT 1
   )
   FOR UPDATE;

  SELECT s.* INTO refunded
  FROM subscriptions s
  WHERE s.source=NEW.provider
    AND s.provider_subscription_id=NEW.provider_subscription_id
    AND s.superseded_by IS NULL
  ORDER BY s.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND OR refunded.starts_at <= NOW() OR refunded.status NOT IN ('active','trialing','past_due','paused','cancelled') THEN
    RETURN NEW;
  END IF;
  -- Already terminated for a money loss: its slot has been dealt with.
  IF refunded.refund_terminated_at IS NOT NULL OR refunded.current_period_end<=refunded.starts_at THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(s.service_type_snapshot,p.service_type,'jellyfin') INTO refunded_service
  FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=refunded.id;
  -- Timestamp subtraction produces calendar-day fields. Applying those to a
  -- different date can cross DST and remove an extra/missing hour. Preserve
  -- the exact elapsed service span, as the application refund owner does.
  removed_seconds:=EXTRACT(EPOCH FROM (
    (refunded.current_period_end+((COALESCE(refunded.service_extension_days,0)||' days')::interval))-refunded.starts_at
  ))::numeric;

  UPDATE subscriptions
     SET status='expired', service_extension_days=0, updated_at=NOW()
   WHERE id=refunded.id;

  PERFORM public.pull_prepaid_queue(
    refunded.customer_id,refunded_service,refunded.current_period_end,removed_seconds,refunded.id,NULL
  );

  RETURN NEW;
END;
$$;

-- As 20261127150000. The customer is now locked before any full refund or lost
-- chargeback that names a payment row is inserted, auto-renewing ones included:
-- whether its time has been carried cannot be known safely before that lock.
-- Everything after the lock block is unchanged.
CREATE OR REPLACE FUNCTION enforce_provider_refund_cash_basis()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    provider_paid_text text;
    provider_paid bigint;
    money_lost boolean := FALSE;
BEGIN
    -- lock-before-insert begin
    IF TG_OP='INSERT' AND NEW.provider_subscription_id IS NOT NULL THEN
        IF NEW.incident_type='refund' THEN
            money_lost := COALESCE((NEW.metadata->>'fullRefund')::boolean,FALSE);
        ELSIF NEW.incident_type='chargeback' THEN
            money_lost := COALESCE(NEW.incident_status='lost',FALSE);
        END IF;
        IF money_lost THEN
            PERFORM 1 FROM public.customers
             WHERE id IN (
               SELECT NEW.customer_id
               UNION
               SELECT s.customer_id FROM public.subscriptions s
                WHERE s.source=NEW.provider
                  AND s.provider_subscription_id=NEW.provider_subscription_id
             )
             ORDER BY id
             FOR UPDATE;
        END IF;
    END IF;
    -- lock-before-insert end

    IF NEW.incident_type <> 'refund' OR NEW.amount_minor IS NULL THEN
        RETURN NEW;
    END IF;

    provider_paid_text := COALESCE(
        NEW.metadata->>'providerPaidMinor',
        NEW.metadata->>'originalAmountMinor'
    );

    IF provider_paid_text IS NULL THEN
        RETURN NEW;
    END IF;

    IF provider_paid_text !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'Refund provider-paid amount must be a non-negative integer';
    END IF;

    provider_paid := provider_paid_text::bigint;
    IF NEW.amount_minor < 0 THEN
        RAISE EXCEPTION 'Refund amount cannot be negative';
    END IF;
    IF NEW.amount_minor > provider_paid THEN
        RAISE EXCEPTION 'Cash refund (%) exceeds money paid through provider (%); affiliate/service credit is not cash-refundable', NEW.amount_minor, provider_paid;
    END IF;

    RETURN NEW;
END;
$$;

-- Runtime roles need the table and functions as soon as this commits, because a
-- payment may be activated before db:runtime-roles runs. A fresh install has no
-- runtime roles yet; that script grants them there.
DO $grants$
DECLARE
  runtime_role text;
  carried_function text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['steamfusion_app','steamfusion_automation'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE 'GRANT SELECT,INSERT,UPDATE ON TABLE public.subscription_time_carryovers TO '||quote_ident(runtime_role);
      FOREACH carried_function IN ARRAY ARRAY[
        'public.carryable_paid_time(uuid,text,text,integer,integer,uuid)',
        'public.carry_candidates(uuid)',
        'public.carried_time_precheck(uuid,uuid,jsonb)',
        'public.carried_time_total_days(uuid,uuid,timestamptz,timestamptz,numeric)',
        'public.rebalance_carried_time(uuid)',
        'public.carry_paid_time(uuid,uuid,numeric,text)',
        'public.carry_all_paid_time(uuid,jsonb,text)',
        'public.apply_carried_change(uuid,integer)',
        'public.reverse_carried_paid_time(uuid,text)',
        'public.reverse_carried_paid_time_by_payment(text,text,boolean,text)',
        'public.reduce_carried_paid_time(uuid,numeric,boolean,text)',
        'public.return_carried_paid_time(uuid,text)',
        'public.subscription_access_blocked(uuid,text,text)'
      ] LOOP
        EXECUTE 'GRANT EXECUTE ON FUNCTION '||carried_function||' TO '||quote_ident(runtime_role);
      END LOOP;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='steamfusion_backup') THEN
    GRANT SELECT ON TABLE public.subscription_time_carryovers TO steamfusion_backup;
  END IF;
END
$grants$;

COMMIT;
