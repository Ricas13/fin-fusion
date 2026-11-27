BEGIN;

-- Nothing here changes a table or a trigger. Give up quickly rather than queue
-- behind (and in front of) live traffic if any catalog lock is unavailable.
SET LOCAL lock_timeout = '5s';

-- A new one-off purchase must not run on top of paid time the customer still
-- holds, and moving queued purchases (refunds, bought extensions) must never
-- create such an overlap either.
-- Rolling-compatible and repeatable: functions only. The stacking and refund
-- triggers created by 20260829202000 and 20260829212000 call the replaced
-- functions, so no trigger is dropped or created on a live table.

CREATE OR REPLACE FUNCTION public.prepaid_lanes_overlap(p_left text,p_right text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_left=p_right OR p_left='bundle' OR p_right='bundle'
$$;

-- A provider agreement that bills by itself. Stripe uses sub_* and PayPal I-*.
CREATE OR REPLACE FUNCTION public.prepaid_row_is_recurring(
  p_source text,p_provider_subscription_id text,p_billing_mode text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (p_source IN ('stripe','paypal') AND p_billing_mode='subscription')
    OR (p_source='stripe' AND COALESCE(p_provider_subscription_id,'') ~* '^sub_')
    OR (p_source='paypal' AND COALESCE(p_provider_subscription_id,'') ~* '^I-')
  ,FALSE)
$$;

-- The single definition of "paid time that a later purchase must not overlap".
-- Auto-renewing recurring agreements are provider-authoritative and are not in
-- it. Free tier, free claim, admin grant, invitation and hand-made manual rows
-- are not in it either. Access ends include service extension days.
CREATE OR REPLACE FUNCTION public.prepaid_paid_time(p_customer uuid)
RETURNS TABLE(subscription_id uuid,service_type text,starts_at timestamptz,access_end timestamptz)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT s.id,
         COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin'),
         s.starts_at,
         s.current_period_end+((COALESCE(s.service_extension_days,0)||' days')::interval)
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    CROSS JOIN LATERAL (
      SELECT public.prepaid_row_is_recurring(s.source,s.provider_subscription_id,s.billing_mode) AS recurring
    ) kind
   WHERE s.customer_id=p_customer
     AND s.superseded_by IS NULL
     AND s.refund_terminated_at IS NULL
     AND COALESCE(p.is_addon,FALSE)=FALSE
     AND COALESCE(p.is_free_tier,FALSE)=FALSE
     AND (
       (s.source IN ('stripe','paypal','plisio') AND NOT kind.recurring)
       OR (
         COALESCE(NULLIF(s.billing_interval_snapshot,''),p.billing_interval,'')<>'trial'
         AND (
           s.source IN ('migration','service_credit')
           OR (s.source='manual' AND COALESCE(s.commercial_snapshot->>'settlementKind','')='fully_discounted_local')
           -- A recurring agreement that will not renew is paid time with a fixed end.
           OR (s.source IN ('stripe','paypal') AND kind.recurring AND s.cancel_at_period_end
               AND s.status IN ('active','cancelled','expired'))
         )
       )
     )
     AND (
       s.status IN ('active','trialing','past_due','paused')
       OR (s.status IN ('cancelled','expired') AND COALESCE(s.service_extension_days,0)>0)
     )
     AND s.current_period_end+((COALESCE(s.service_extension_days,0)||' days')::interval)>NOW()
     -- Lifetime sentinels cannot be queued behind: the purchase would never start.
     AND s.current_period_end<NOW()+INTERVAL '20 years'
$$;

-- Only these rows are ever queued by the stacking trigger, so only these move.
CREATE OR REPLACE FUNCTION public.prepaid_row_is_queueable(
  p_source text,p_provider_subscription_id text,p_billing_mode text,p_commercial_snapshot jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (
      p_source IN ('stripe','paypal','plisio')
      AND NOT public.prepaid_row_is_recurring(p_source,p_provider_subscription_id,p_billing_mode)
    )
    OR (p_source='manual' AND COALESCE(p_commercial_snapshot->>'settlementKind','')='fully_discounted_local')
  ,FALSE)
$$;

-- TRUE when a purchase of p_plan gives no more than the held subscription does:
-- the same plan, or the same service and server class with no higher stream or
-- household allowance. Anything unknown is an upgrade.
CREATE OR REPLACE FUNCTION public.prepaid_access_covered(
  p_plan uuid,p_service text,p_snapshot jsonb,p_households integer,p_held uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT held.plan_id=bought.id
        OR (
          COALESCE(NULLIF(held.service_type_snapshot,''),held_plan.service_type,'jellyfin')=p_service
          AND COALESCE(NULLIF(p_snapshot->>'serverClass',''),bought.server_class)
              =COALESCE(NULLIF(held.commercial_snapshot->>'serverClass',''),held_plan.server_class)
          AND (
            p_service='stremio'
            OR COALESCE(CASE WHEN p_snapshot->>'streams' ~ '^[0-9]{1,4}$' THEN (p_snapshot->>'streams')::integer END,bought.streams)
               <=COALESCE(CASE WHEN held.commercial_snapshot->>'streams' ~ '^[0-9]{1,4}$' THEN (held.commercial_snapshot->>'streams')::integer END,held_plan.streams)
          )
          AND (
            p_service NOT IN ('stremio','bundle')
            OR COALESCE(CASE WHEN p_snapshot->>'stremioHouseholdNetworkLimit' ~ '^[0-9]{1,4}$' THEN (p_snapshot->>'stremioHouseholdNetworkLimit')::integer END,p_households,bought.stremio_household_network_limit)
               <=COALESCE(CASE WHEN held.commercial_snapshot->>'stremioHouseholdNetworkLimit' ~ '^[0-9]{1,4}$' THEN (held.commercial_snapshot->>'stremioHouseholdNetworkLimit')::integer END,held.stremio_household_network_limit_snapshot,held_plan.stremio_household_network_limit)
          )
        )
      FROM subscriptions held
      JOIN plans held_plan ON held_plan.id=held.plan_id
      JOIN plans bought ON bought.id=p_plan
     WHERE held.id=p_held
  ),FALSE)
$$;

-- Where a purchase of this kind has to wait, per held subscription. Stacking and
-- every later queue movement use this one definition.
--   * Provider one-off purchases keep the rule of 20260829202000: behind the base
--     term of live provider one-offs on the lane, whatever they bought.
--   * Everything else that counts as paid time (extension days, imported,
--     service-credit, zero-value and ending recurring rows) only holds back a
--     purchase that gives no more access than it does. An upgrade is not delayed.
CREATE OR REPLACE FUNCTION public.prepaid_stack_anchors(
  p_customer uuid,p_plan uuid,p_service text,p_snapshot jsonb,p_households integer,p_provider boolean
)
RETURNS TABLE(subscription_id uuid,starts_at timestamptz,anchor_end timestamptz)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT anchors.held_id,MIN(anchors.held_start),MAX(anchors.held_end)
    FROM (
      SELECT s.id AS held_id,s.starts_at AS held_start,s.current_period_end AS held_end
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
       WHERE p_provider
         AND s.customer_id=p_customer
         AND s.superseded_by IS NULL
         AND COALESCE(p.is_addon,FALSE)=FALSE
         AND s.status IN ('active','trialing','past_due','paused')
         AND s.current_period_end>NOW()
         AND s.source IN ('stripe','paypal','plisio')
         AND NOT (s.source='stripe' AND COALESCE(s.provider_subscription_id,'') ~* '^sub_')
         AND NOT (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') ~* '^I-')
         AND public.prepaid_lanes_overlap(COALESCE(s.service_type_snapshot,p.service_type,'jellyfin'),p_service)
      UNION ALL
      SELECT paid.subscription_id,paid.starts_at,paid.access_end
        FROM public.prepaid_paid_time(p_customer) paid
       WHERE public.prepaid_access_covered(p_plan,p_service,p_snapshot,p_households,paid.subscription_id)
    ) anchors
   GROUP BY anchors.held_id
$$;

-- Called by trg_stack_prepaid_subscription_window, which runs after the
-- snapshot, billing-mode, free-tier and money-loss triggers (name order).
-- This runs at activation, after payment: it only moves the window, never refuses.
CREATE OR REPLACE FUNCTION stack_prepaid_subscription_window()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_service text;
  target_is_addon boolean;
  target_is_free boolean;
  stack_end timestamptz;
  interval_name text;
  duration_days integer;
  held_server_id uuid;
  held_location text;
BEGIN
  IF NOT public.prepaid_row_is_queueable(NEW.source,NEW.provider_subscription_id,NEW.billing_mode,NEW.commercial_snapshot) THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('active','trialing') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(service_type,'jellyfin'),
         COALESCE(is_addon,FALSE),COALESCE(is_free_tier,FALSE)
    INTO target_service,target_is_addon,target_is_free
    FROM plans
   WHERE id=NEW.plan_id;

  IF target_is_addon OR target_is_free THEN
    RETURN NEW;
  END IF;

  -- Keep stacking safe even if two provider completions arrive together.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.customer_id::text,0));

  SELECT MAX(waiting.anchor_end)
    INTO stack_end
    FROM public.prepaid_stack_anchors(
      NEW.customer_id,NEW.plan_id,target_service,NEW.commercial_snapshot,
      NEW.stremio_household_network_limit_snapshot,NEW.source IN ('stripe','paypal','plisio')
    ) waiting;

  IF stack_end IS NULL OR stack_end<=NOW() THEN
    RETURN NEW;
  END IF;

  interval_name:=LOWER(COALESCE(NEW.billing_interval_snapshot,(NEW.commercial_snapshot->>'billingInterval'),''));
  duration_days:=COALESCE(NEW.duration_days_snapshot,NULLIF((NEW.commercial_snapshot->>'durationDays')::integer,0),30);

  NEW.starts_at:=stack_end;
  NEW.current_period_end:=CASE interval_name
    WHEN 'month' THEN stack_end + INTERVAL '1 month'
    WHEN '6_months' THEN stack_end + INTERVAL '6 months'
    WHEN 'year' THEN stack_end + INTERVAL '1 year'
    ELSE stack_end + (GREATEST(1,duration_days)::text || ' days')::interval
  END;

  -- A queued repurchase of the same plan keeps the server the customer already
  -- occupies, unless this purchase chose a different location.
  SELECT held.media_server_id,held.media_location_snapshot
    INTO held_server_id,held_location
    FROM subscriptions held
    JOIN jellyfin_servers host_server ON host_server.id=held.media_server_id AND host_server.enabled=TRUE
   WHERE held.customer_id=NEW.customer_id
     AND held.plan_id=NEW.plan_id
     AND held.superseded_by IS NULL
     AND held.refund_terminated_at IS NULL
     AND held.starts_at<=NOW()
     AND held.current_period_end+((COALESCE(held.service_extension_days,0)||' days')::interval)>NOW()
     AND (held.status IN ('active','trialing','past_due','paused') OR COALESCE(held.service_extension_days,0)>0)
     AND (
       NULLIF(BTRIM(COALESCE(NEW.commercial_snapshot->>'mediaLocation','')),'') IS NULL
       OR LOWER(BTRIM(COALESCE(held.media_location_snapshot,'')))=LOWER(BTRIM(NEW.commercial_snapshot->>'mediaLocation'))
     )
   ORDER BY held.current_period_end DESC,held.created_at DESC
   LIMIT 1;

  IF held_server_id IS NOT NULL THEN
    NEW.media_server_id:=held_server_id;
    NEW.media_location_preference:=COALESCE(held_location,NEW.media_location_preference);
    NEW.media_location_snapshot:=COALESCE(held_location,NEW.media_location_snapshot);
  END IF;

  RETURN NEW;
END;
$$;

-- Move queued purchases earlier after paid time ahead of them was removed.
-- Each row moves by at most the removed span, and never to before now, before
-- p_floor, before anything it would be queued behind, or into paid time that
-- ends before it currently starts. Durations are preserved exactly.
CREATE OR REPLACE FUNCTION public.pull_prepaid_queue(
  p_customer uuid,p_service text,p_from timestamptz,p_removed_seconds numeric,
  p_exclude uuid DEFAULT NULL,p_floor timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  queued record;
  floor_at timestamptz;
  pull_seconds numeric;
  moved integer:=0;
BEGIN
  IF p_removed_seconds IS NULL OR p_removed_seconds<=0 THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM subscriptions s
     WHERE s.customer_id=p_customer AND s.starts_at>=p_from AND s.superseded_by IS NULL
       AND s.id IS DISTINCT FROM p_exclude
  ) THEN
    RETURN 0;
  END IF;

  -- Same order as an insert: customer row, then the stacking lock.
  PERFORM 1 FROM customers WHERE id=p_customer FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_customer::text,0));

  FOR queued IN
    SELECT s.id,s.starts_at,s.plan_id,s.source,s.commercial_snapshot,
           s.stremio_household_network_limit_snapshot AS households,
           COALESCE(p.service_type,'jellyfin') AS target_service,
           COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') AS service_type
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
     WHERE s.customer_id=p_customer
       AND s.id IS DISTINCT FROM p_exclude
       AND s.superseded_by IS NULL
       AND s.refund_terminated_at IS NULL
       AND COALESCE(p.is_addon,FALSE)=FALSE
       AND s.starts_at>=p_from
       AND s.status IN ('active','trialing','past_due','paused','cancelled')
       AND public.prepaid_row_is_queueable(s.source,s.provider_subscription_id,s.billing_mode,s.commercial_snapshot)
       AND public.prepaid_lanes_overlap(COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin'),p_service)
     ORDER BY s.starts_at,s.created_at,s.id
  LOOP
    SELECT GREATEST(NOW(),p_floor,MAX(candidate.held_end))
      INTO floor_at
      FROM (
        SELECT waiting.subscription_id AS held_id,waiting.starts_at AS held_start,waiting.anchor_end AS held_end
          FROM public.prepaid_stack_anchors(
            p_customer,queued.plan_id,queued.target_service,queued.commercial_snapshot,
            queued.households,queued.source IN ('stripe','paypal','plisio')
          ) waiting
        UNION ALL
        SELECT paid.subscription_id,paid.starts_at,paid.access_end
          FROM public.prepaid_paid_time(p_customer) paid
         WHERE paid.access_end<=queued.starts_at
           AND public.prepaid_lanes_overlap(paid.service_type,queued.service_type)
      ) candidate
     WHERE candidate.held_id<>queued.id
       AND candidate.held_id IS DISTINCT FROM p_exclude
       AND (candidate.held_start,candidate.held_id)<(queued.starts_at,queued.id);

    pull_seconds:=LEAST(p_removed_seconds,GREATEST(0,EXTRACT(EPOCH FROM (queued.starts_at-floor_at))::numeric));
    IF pull_seconds>0 THEN
      UPDATE subscriptions
         SET starts_at=starts_at-(pull_seconds * INTERVAL '1 second'),
             current_period_end=current_period_end-(pull_seconds * INTERVAL '1 second'),
             updated_at=NOW()
       WHERE id=queued.id;
      moved:=moved+1;
    END IF;
  END LOOP;

  RETURN moved;
END;
$$;

-- Call in the same transaction that changed a subscription's paid end: bought
-- or operator-added days, or a new period end. A later end pushes the queue; an
-- earlier one pulls it back. NULL p_previous_period_end means it did not change.
CREATE OR REPLACE FUNCTION public.shift_prepaid_queue_after_end_change(
  p_subscription uuid,p_previous_extension_days integer,p_previous_period_end timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  anchor subscriptions%ROWTYPE;
  anchor_service text;
  anchor_end timestamptz;
  previous_period_end timestamptz;
  changed_seconds numeric;
  queued record;
  blocker timestamptz;
  push_seconds numeric;
  moved_ids uuid[];
  moved integer:=0;
BEGIN
  SELECT * INTO anchor FROM subscriptions WHERE id=p_subscription;
  IF NOT FOUND OR anchor.superseded_by IS NOT NULL OR anchor.refund_terminated_at IS NOT NULL THEN
    RETURN 0;
  END IF;

  -- A lifetime end is not something to wait behind: pushing a purchase after it
  -- would mean it never starts.
  IF anchor.current_period_end>=NOW()+INTERVAL '20 years' THEN
    RETURN 0;
  END IF;

  previous_period_end:=COALESCE(p_previous_period_end,anchor.current_period_end);
  anchor_end:=anchor.current_period_end+((COALESCE(anchor.service_extension_days,0)||' days')::interval);
  changed_seconds:=EXTRACT(EPOCH FROM (
    anchor_end-(previous_period_end+((COALESCE(p_previous_extension_days,0)||' days')::interval))
  ))::numeric;

  IF ABS(changed_seconds)<1 OR NOT EXISTS (
    SELECT 1 FROM subscriptions s
     WHERE s.customer_id=anchor.customer_id AND s.id<>anchor.id AND s.superseded_by IS NULL
       AND s.starts_at>NOW() AND s.starts_at>=previous_period_end
  ) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(NULLIF(anchor.service_type_snapshot,''),p.service_type,'jellyfin')
    INTO anchor_service FROM plans p WHERE p.id=anchor.plan_id;

  IF changed_seconds<0 THEN
    RETURN public.pull_prepaid_queue(
      anchor.customer_id,anchor_service,previous_period_end,-changed_seconds,anchor.id,anchor_end
    );
  END IF;

  PERFORM 1 FROM customers WHERE id=anchor.customer_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(anchor.customer_id::text,0));
  moved_ids:=ARRAY[anchor.id];

  FOR queued IN
    SELECT s.id,s.starts_at,s.plan_id,s.source,s.commercial_snapshot,
           s.stremio_household_network_limit_snapshot AS households,
           COALESCE(p.service_type,'jellyfin') AS target_service
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
     WHERE s.customer_id=anchor.customer_id
       AND s.id<>anchor.id
       AND s.superseded_by IS NULL
       AND s.refund_terminated_at IS NULL
       AND COALESCE(p.is_addon,FALSE)=FALSE
       AND s.starts_at>NOW()
       AND s.starts_at>=previous_period_end
       AND s.status IN ('active','trialing','past_due','paused','cancelled')
       AND public.prepaid_row_is_queueable(s.source,s.provider_subscription_id,s.billing_mode,s.commercial_snapshot)
     ORDER BY s.starts_at,s.created_at,s.id
  LOOP
    -- Only a row that has to wait for the changed row, or for one moved with it.
    SELECT MAX(waiting.anchor_end)
      INTO blocker
      FROM public.prepaid_stack_anchors(
        anchor.customer_id,queued.plan_id,queued.target_service,queued.commercial_snapshot,
        queued.households,queued.source IN ('stripe','paypal','plisio')
      ) waiting
     WHERE waiting.subscription_id=ANY(moved_ids);

    CONTINUE WHEN blocker IS NULL;
    push_seconds:=LEAST(changed_seconds,GREATEST(0,EXTRACT(EPOCH FROM (blocker-queued.starts_at))::numeric));
    IF push_seconds>0 THEN
      UPDATE subscriptions
         SET starts_at=starts_at+(push_seconds * INTERVAL '1 second'),
             current_period_end=current_period_end+(push_seconds * INTERVAL '1 second'),
             updated_at=NOW()
       WHERE id=queued.id;
      moved_ids:=moved_ids||queued.id;
      moved:=moved+1;
    END IF;
  END LOOP;

  RETURN moved;
END;
$$;

-- Starts from 20261001163000_refund_queue_elapsed_time.sql. The removed span is
-- now the whole refunded access slot (base term plus extension days), matching
-- where later purchases are queued, and a second refund event moves nothing.
CREATE OR REPLACE FUNCTION reconcile_future_prepaid_full_refund()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refunded subscriptions%ROWTYPE;
  refunded_service text;
  removed_seconds numeric;
BEGIN
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

  -- One lock order everywhere: the customer, then the subscription.
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

-- Runtime roles call these from the stacking and refund triggers and from the
-- application, from the moment this commits, so grant here instead of waiting
-- for db:runtime-roles. A fresh install has no runtime roles yet; that script
-- grants them there.
DO $grants$
DECLARE
  runtime_role text;
  paid_time_function text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['steamfusion_app','steamfusion_automation'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      FOREACH paid_time_function IN ARRAY ARRAY[
        'public.prepaid_access_covered(uuid,text,jsonb,integer,uuid)',
        'public.prepaid_lanes_overlap(text,text)',
        'public.prepaid_paid_time(uuid)',
        'public.prepaid_row_is_recurring(text,text,text)',
        'public.prepaid_stack_anchors(uuid,uuid,text,jsonb,integer,boolean)',
        'public.prepaid_row_is_queueable(text,text,text,jsonb)',
        'public.pull_prepaid_queue(uuid,text,timestamptz,numeric,uuid,timestamptz)',
        'public.shift_prepaid_queue_after_end_change(uuid,integer,timestamptz)'
      ] LOOP
        EXECUTE 'GRANT EXECUTE ON FUNCTION '||paid_time_function||' TO '||quote_ident(runtime_role);
      END LOOP;
    END IF;
  END LOOP;
END
$grants$;

COMMIT;
