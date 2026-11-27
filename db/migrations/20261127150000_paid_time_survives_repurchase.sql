-- A new one-off purchase must not run on top of paid time the customer still
-- holds, and moving queued purchases (refunds, bought extensions) must never
-- create such an overlap either.
-- Rolling-compatible and repeatable: functions only, no table changes.
BEGIN;

CREATE OR REPLACE FUNCTION public.prepaid_lanes_overlap(p_left text,p_right text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_left=p_right
      OR (p_left='bundle' AND p_right IN ('jellyfin','stremio'))
      OR (p_right='bundle' AND p_left IN ('jellyfin','stremio'))
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
      SELECT (s.source IN ('stripe','paypal') AND s.billing_mode='subscription')
          OR (s.source='stripe' AND COALESCE(s.provider_subscription_id,'') ~* '^sub_')
          OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') ~* '^I-') AS recurring
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
      AND NOT (p_source IN ('stripe','paypal') AND COALESCE(p_billing_mode,'')='subscription')
      AND NOT (p_source='stripe' AND COALESCE(p_provider_subscription_id,'') ~* '^sub_')
      AND NOT (p_source='paypal' AND COALESCE(p_provider_subscription_id,'') ~* '^I-')
    )
    OR (p_source='manual' AND COALESCE(p_commercial_snapshot->>'settlementKind','')='fully_discounted_local')
  ,FALSE)
$$;

-- Runs after the snapshot, billing-mode, free-tier and money-loss triggers
-- (BEFORE triggers fire in name order). Keep the trigger name.
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

  SELECT COALESCE(NULLIF(NEW.service_type_snapshot,''),service_type,'jellyfin'),
         COALESCE(is_addon,FALSE),COALESCE(is_free_tier,FALSE)
    INTO target_service,target_is_addon,target_is_free
    FROM plans
   WHERE id=NEW.plan_id;

  IF target_is_addon OR target_is_free THEN
    RETURN NEW;
  END IF;

  -- Keep stacking safe even if two provider completions arrive together.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.customer_id::text,0));

  SELECT MAX(paid.access_end)
    INTO stack_end
    FROM public.prepaid_paid_time(NEW.customer_id) paid
   WHERE public.prepaid_lanes_overlap(paid.service_type,target_service);

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

DROP TRIGGER IF EXISTS trg_stack_prepaid_subscription_window ON subscriptions;
CREATE TRIGGER trg_stack_prepaid_subscription_window
BEFORE INSERT ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION stack_prepaid_subscription_window();

-- Move queued purchases earlier after paid time ahead of them was removed.
-- Each row moves by at most the removed span, and never to before now, before
-- p_floor, or into paid time that precedes it. Durations are preserved exactly.
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
    SELECT s.id,s.starts_at,
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
    SELECT GREATEST(NOW(),p_floor,MAX(paid.access_end))
      INTO floor_at
      FROM public.prepaid_paid_time(p_customer) paid
     WHERE paid.subscription_id<>queued.id
       AND paid.subscription_id IS DISTINCT FROM p_exclude
       AND public.prepaid_lanes_overlap(paid.service_type,queued.service_type)
       AND (paid.starts_at,paid.subscription_id)<(queued.starts_at,queued.id);

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

-- Call in the same transaction that changed a subscription's bought extension
-- days. Added days push the queue later; removed days pull it back.
CREATE OR REPLACE FUNCTION public.shift_prepaid_queue_after_extension_change(
  p_subscription uuid,p_previous_extension_days integer
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  anchor subscriptions%ROWTYPE;
  anchor_service text;
  anchor_end timestamptz;
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

  anchor_end:=anchor.current_period_end+((COALESCE(anchor.service_extension_days,0)||' days')::interval);
  changed_seconds:=EXTRACT(EPOCH FROM (
    anchor_end-(anchor.current_period_end+((COALESCE(p_previous_extension_days,0)||' days')::interval))
  ))::numeric;

  IF changed_seconds=0 OR NOT EXISTS (
    SELECT 1 FROM subscriptions s
     WHERE s.customer_id=anchor.customer_id AND s.id<>anchor.id AND s.superseded_by IS NULL
       AND s.starts_at>NOW() AND s.starts_at>=anchor.current_period_end
  ) THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(NULLIF(anchor.service_type_snapshot,''),p.service_type,'jellyfin')
    INTO anchor_service FROM plans p WHERE p.id=anchor.plan_id;

  IF changed_seconds<0 THEN
    RETURN public.pull_prepaid_queue(
      anchor.customer_id,anchor_service,anchor.current_period_end,-changed_seconds,anchor.id,anchor_end
    );
  END IF;

  PERFORM 1 FROM customers WHERE id=anchor.customer_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(anchor.customer_id::text,0));
  moved_ids:=ARRAY[anchor.id];

  FOR queued IN
    SELECT s.id,s.starts_at,
           COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') AS service_type
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
     WHERE s.customer_id=anchor.customer_id
       AND s.id<>anchor.id
       AND s.superseded_by IS NULL
       AND s.refund_terminated_at IS NULL
       AND COALESCE(p.is_addon,FALSE)=FALSE
       AND s.starts_at>NOW()
       AND s.starts_at>=anchor.current_period_end
       AND s.status IN ('active','trialing','past_due','paused','cancelled')
       AND public.prepaid_row_is_queueable(s.source,s.provider_subscription_id,s.billing_mode,s.commercial_snapshot)
     ORDER BY s.starts_at,s.created_at,s.id
  LOOP
    -- Only rows now overlapped by the anchor, or by a row moved because of it.
    SELECT MAX(ahead.current_period_end+((COALESCE(ahead.service_extension_days,0)||' days')::interval))
      INTO blocker
      FROM subscriptions ahead
      JOIN plans p ON p.id=ahead.plan_id
     WHERE ahead.id=ANY(moved_ids)
       AND public.prepaid_lanes_overlap(COALESCE(NULLIF(ahead.service_type_snapshot,''),p.service_type,'jellyfin'),queued.service_type);

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

COMMIT;
