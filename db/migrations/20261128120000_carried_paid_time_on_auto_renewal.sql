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
  -- Source time still carried, in the source's own units.
  carried_seconds bigint NOT NULL CHECK (carried_seconds>=0),
  -- Days that time contributes to the receiving row.
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
  SELECT COALESCE(BOOL_OR(held.lifetime),FALSE),
         COALESCE(SUM(CEIL(held.carried_seconds/86400.0)),0)::bigint
    FROM plans bought
    CROSS JOIN LATERAL public.carryable_paid_time(
      p_customer,
      COALESCE(bought.service_type,'jellyfin'),
      COALESCE(NULLIF(p_snapshot->>'serverClass',''),bought.server_class),
      COALESCE(CASE WHEN p_snapshot->>'streams' ~ '^[0-9]{1,4}$' THEN (p_snapshot->>'streams')::integer END,bought.streams),
      COALESCE(CASE WHEN p_snapshot->>'stremioHouseholdNetworkLimit' ~ '^[0-9]{1,4}$' THEN (p_snapshot->>'stremioHouseholdNetworkLimit')::integer END,bought.stremio_household_network_limit),
      NULL
    ) held
   WHERE bought.id=p_plan
     AND COALESCE(bought.is_addon,FALSE)=FALSE
     AND COALESCE(bought.is_free_tier,FALSE)=FALSE
     AND COALESCE(bought.billing_interval,'')<>'trial'
$$;

-- Move one source's remaining time onto a receiving row. Callable on its own.
-- Returns the days added, 0 when the source is not eligible, and -1 when it
-- would exceed the 3,650-day limit (the source is then left exactly as it was).
-- It never refuses a paid activation by raising.
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
  exact_days numeric;
  days integer;
BEGIN
  SELECT s.customer_id INTO owner_id FROM subscriptions s WHERE s.id=p_target;
  IF owner_id IS NULL OR p_ratio IS NULL OR p_ratio<=0 THEN
    RETURN 0;
  END IF;

  -- One lock order everywhere: the customer, the stacking lock, subscriptions.
  PERFORM 1 FROM customers WHERE id=owner_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  SELECT * INTO receiving FROM subscriptions WHERE id=p_target FOR UPDATE;
  SELECT * INTO donor FROM subscriptions WHERE id=p_source AND customer_id=owner_id FOR UPDATE;
  IF donor.id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT * INTO candidate FROM public.carry_candidates(p_target) c WHERE c.subscription_id=p_source;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  IF candidate.lifetime OR COALESCE(candidate.carried_seconds,0)<=0 THEN
    RETURN 0;
  END IF;

  exact_days:=CEIL((candidate.carried_seconds::numeric*p_ratio)/86400);
  IF COALESCE(receiving.service_extension_days,0)+exact_days>3650 THEN
    RETURN -1;
  END IF;
  days:=exact_days::integer;

  INSERT INTO subscription_time_carryovers(
    customer_id,target_subscription_id,source_subscription_id,source_provider,source_payment_ref,
    carried_seconds,applied_days,value_ratio,target_first_period_end,reason
  ) VALUES(
    owner_id,p_target,p_source,donor.source,donor.provider_subscription_id,
    candidate.carried_seconds,days,p_ratio,receiving.current_period_end,p_reason
  );

  UPDATE subscriptions
     SET superseded_by=p_target,replaced_at=NOW(),replacement_reason='paid_time_carried',updated_at=NOW()
   WHERE id=p_source;

  -- The customer keeps the server they already occupy unless the new purchase
  -- chose a placement of its own.
  UPDATE subscriptions
     SET service_extension_days=COALESCE(service_extension_days,0)+days,
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
    'customerId',owner_id,'sourceSubscriptionId',p_source,'carriedSeconds',candidate.carried_seconds,
    'appliedDays',days,'valueRatio',p_ratio,'reason',p_reason));

  RETURN days;
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

  SELECT ARRAY_AGG(c.subscription_id ORDER BY c.starts_at,c.subscription_id)
    INTO source_ids FROM public.carry_candidates(p_target) c;

  FOREACH source_id IN ARRAY COALESCE(source_ids,ARRAY[]::uuid[]) LOOP
    days:=public.carry_paid_time(p_target,source_id,COALESCE((p_ratios->>source_id::text)::numeric,1),p_reason);
    IF days>0 THEN
      total:=total+days;
      carried:=carried||jsonb_build_object('subscriptionId',source_id,'days',days);
    ELSE
      skipped:=skipped||jsonb_build_object('subscriptionId',source_id,'reason',CASE WHEN days<0 THEN 'over_limit' ELSE 'not_carried' END);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('days',total,'carried',carried,'skipped',skipped);
END;
$$;

-- Take days off the row that holds them, following carried time that has since
-- moved on again. Separately bought extension days are never removed. The caller
-- holds the customer lock. Returns the row that finally holds the time.
CREATE OR REPLACE FUNCTION public.remove_carried_days(p_target uuid,p_days integer)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  holder uuid:=p_target;
  remaining integer:=GREATEST(0,COALESCE(p_days,0));
  previous integer;
  bought bigint;
  next_entry subscription_time_carryovers%ROWTYPE;
  next_days integer;
BEGIN
  FOR step IN 1..100 LOOP
    SELECT COALESCE(service_extension_days,0) INTO previous FROM subscriptions WHERE id=holder FOR UPDATE;
    EXIT WHEN previous IS NULL;
    SELECT COALESCE(SUM(applied_days),0) INTO bought
      FROM subscription_access_extensions WHERE subscription_id=holder AND status='active';
    IF previous>0 AND remaining>0 THEN
      UPDATE subscriptions
         SET service_extension_days=GREATEST(LEAST(previous,bought)::integer,previous-remaining),updated_at=NOW()
       WHERE id=holder;
      PERFORM public.shift_prepaid_queue_after_end_change(holder,previous);
    END IF;

    SELECT * INTO next_entry FROM subscription_time_carryovers
     WHERE source_subscription_id=holder AND status='active' FOR UPDATE;
    EXIT WHEN NOT FOUND;
    remaining:=LEAST(remaining,next_entry.applied_days);
    next_days:=next_entry.applied_days-remaining;
    UPDATE subscription_time_carryovers
       SET applied_days=next_days,
           carried_seconds=LEAST(carried_seconds,FLOOR(next_days*86400/value_ratio)::bigint),
           status=CASE WHEN next_days=0 THEN 'reversed' ELSE status END,
           closed_at=CASE WHEN next_days=0 THEN NOW() ELSE closed_at END
     WHERE id=next_entry.id;
    holder:=next_entry.target_subscription_id;
  END LOOP;
  RETURN holder;
END;
$$;

-- The source's own payment was lost (full refund or lost chargeback): take its
-- carried days back, once. Time carried into the source from other payments, and
-- extensions bought on it, stay. Returns NULL when nothing is carried from it.
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

  SELECT COALESCE((SELECT SUM(e.applied_days) FROM subscription_access_extensions e
                    WHERE e.subscription_id=p_source AND e.status='active'),0)
        +COALESCE((SELECT SUM(l.applied_days) FROM subscription_time_carryovers l
                    WHERE l.target_subscription_id=p_source AND l.status='active'),0)
    INTO keep;
  keep:=LEAST(keep,entry.applied_days);
  removed:=entry.applied_days-keep;

  IF keep=0 THEN
    UPDATE subscription_time_carryovers SET status='reversed',reason=p_reason,closed_at=NOW() WHERE id=entry.id;
  ELSE
    UPDATE subscription_time_carryovers
       SET applied_days=keep,carried_seconds=LEAST(carried_seconds,FLOOR(keep*86400/value_ratio)::bigint),reason=p_reason
     WHERE id=entry.id;
  END IF;
  IF removed>0 THEN
    PERFORM public.remove_carried_days(entry.target_subscription_id,removed);
  END IF;
  UPDATE subscriptions SET refund_terminated_at=COALESCE(refund_terminated_at,NOW()),updated_at=NOW()
   WHERE id=p_source;

  INSERT INTO audit_log(action,entity_type,entity_id,metadata)
  VALUES('subscription.paid_time.reversed','subscription',entry.target_subscription_id::text,jsonb_build_object(
    'customerId',owner_id,'sourceSubscriptionId',p_source,'removedDays',removed,'keptDays',keep,'reason',p_reason));
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
-- was reversed: take off exactly that span. p_base_payment skips a source whose
-- base payment loss has already been applied. Returns the days removed.
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
  next_seconds bigint;
  next_days integer;
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

  next_seconds:=GREATEST(0,entry.carried_seconds-CEIL(p_removed_seconds)::bigint);
  next_days:=LEAST(entry.applied_days::numeric,CEIL((next_seconds::numeric*entry.value_ratio)/86400))::integer;
  removed:=entry.applied_days-next_days;
  UPDATE subscription_time_carryovers
     SET carried_seconds=next_seconds,applied_days=next_days,reason=p_reason,
         status=CASE WHEN next_days=0 THEN 'reversed' ELSE status END,
         closed_at=CASE WHEN next_days=0 THEN NOW() ELSE closed_at END
   WHERE id=entry.id;
  IF removed>0 THEN
    PERFORM public.remove_carried_days(entry.target_subscription_id,removed);
    INSERT INTO audit_log(action,entity_type,entity_id,metadata)
    VALUES('subscription.paid_time.reduced','subscription',entry.target_subscription_id::text,jsonb_build_object(
      'customerId',owner_id,'sourceSubscriptionId',p_source,'removedDays',removed,'reason',p_reason));
  END IF;
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

-- As 20261127150000. The customer is now also locked before a lost chargeback is
-- inserted, and before any loss that will reverse carried time. Everything after
-- the lock block is unchanged.
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
        IF money_lost AND (
            (NOT (NEW.provider='stripe' AND NEW.provider_subscription_id ~* '^sub_')
             AND NOT (NEW.provider='paypal' AND NEW.provider_subscription_id ~* '^I-'))
            OR EXISTS(
              SELECT 1 FROM public.subscriptions s
                JOIN public.subscription_time_carryovers l ON l.source_subscription_id=s.id AND l.status='active'
               WHERE s.source=NEW.provider AND s.provider_subscription_id=NEW.provider_subscription_id
            )
        ) THEN
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
        'public.carry_paid_time(uuid,uuid,numeric,text)',
        'public.carry_all_paid_time(uuid,jsonb,text)',
        'public.remove_carried_days(uuid,integer)',
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
