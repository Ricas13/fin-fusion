BEGIN;
SET LOCAL lock_timeout='5s';

-- A refunded base contract is permanently terminal. Independently purchased
-- extensions retain their original payment identity but get a distinct local
-- entitlement. No provider agreement, charge, or refunded base is reopened.
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS extension_recovery_of uuid
  REFERENCES public.subscriptions(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_extension_recovery_of_unique
  ON public.subscriptions(extension_recovery_of) WHERE extension_recovery_of IS NOT NULL;
ALTER TABLE public.subscription_access_extensions
  ADD COLUMN IF NOT EXISTS original_subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recovered_days integer CHECK (recovered_days BETWEEN 1 AND 3650);

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
           OR (s.source='manual' AND s.extension_recovery_of IS NOT NULL)
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
    OR (p_source='manual' AND COALESCE(p_commercial_snapshot->>'settlementKind','') IN ('fully_discounted_local','paid_extension_recovery'))
  ,FALSE)
$$;

CREATE OR REPLACE FUNCTION public.recover_independent_paid_extensions(p_source uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  owner_id uuid;
  parent subscriptions%ROWTYPE;
  recovered uuid;
  anchor timestamptz;
  paid_end timestamptz;
  days integer;
  service text;
BEGIN
  SELECT customer_id INTO owner_id FROM subscriptions WHERE id=p_source;
  IF owner_id IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM customers WHERE id=owner_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  SELECT * INTO parent FROM subscriptions WHERE id=p_source FOR UPDATE;
  IF NOT FOUND OR parent.refund_terminated_at IS NULL OR parent.superseded_by IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT id INTO recovered FROM subscriptions WHERE extension_recovery_of=p_source;
  IF recovered IS NOT NULL THEN RETURN recovered; END IF;

  -- Only an existing, independently settled, still-active purchase counts;
  -- operator-added time and already-reversed extensions never qualify.
  PERFORM 1 FROM subscription_access_extensions e
   WHERE e.subscription_id=p_source ORDER BY e.id FOR UPDATE;
  SELECT COALESCE(SUM(e.applied_days),0)::integer INTO days
    FROM subscription_access_extensions e
   WHERE e.subscription_id=p_source AND e.status='active' AND e.applied_days>0
     AND e.customer_id=owner_id AND e.plan_id=parent.plan_id
     AND NOT EXISTS (
       SELECT 1 FROM payment_incidents pi
        WHERE pi.provider=e.provider AND pi.provider_subscription_id=e.provider_payment_id
          AND (pi.incident_type='chargeback' AND pi.incident_status='lost'
            OR pi.incident_type='refund' AND pi.metadata->>'fullRefund'='true')
     );
  IF days=0 THEN RETURN NULL; END IF;

  SELECT COALESCE(NULLIF(parent.service_type_snapshot,''),p.service_type,'jellyfin')
    INTO service FROM plans p WHERE p.id=parent.plan_id;
  -- Never give already consumed extension time a fresh start on replay.
  -- A future prepaid contract retains its original start boundary.
  anchor:=GREATEST(parent.starts_at,LEAST(parent.current_period_end,parent.refund_terminated_at));
  paid_end:=anchor+make_interval(days=>days);
  IF paid_end<=NOW() THEN RETURN NULL; END IF;

  -- A different allowance or an overlapping paid contract requires review,
  -- not an invented extension or an overlapping entitlement. Retain all
  -- source evidence in that case; the base refund still completes.
  IF days>3650 OR EXISTS (
    SELECT 1 FROM subscription_access_extensions e JOIN plans p ON p.id=parent.plan_id
     WHERE e.subscription_id=p_source AND e.status='active' AND e.applied_days>0
       AND (e.customer_id<>owner_id OR e.plan_id<>parent.plan_id
         OR COALESCE(e.commercial_snapshot->>'accessQuantity','') IS DISTINCT FROM
            COALESCE(parent.commercial_snapshot->>'accessQuantity',
              CASE WHEN service='stremio' THEN COALESCE(parent.stremio_household_network_limit_snapshot,p.stremio_household_network_limit)::text
                   ELSE p.streams::text END,''))
  ) OR EXISTS (
    SELECT 1 FROM public.prepaid_paid_time(owner_id) held
     WHERE held.subscription_id<>p_source
       AND public.prepaid_lanes_overlap(held.service_type,service)
       AND held.starts_at<paid_end AND held.access_end>GREATEST(NOW(),anchor)
  ) OR EXISTS (
    SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id
     WHERE s.customer_id=owner_id AND s.id<>p_source AND s.superseded_by IS NULL
       AND s.refund_terminated_at IS NULL AND s.status IN ('active','trialing','past_due','paused')
       AND s.billing_mode='subscription' AND s.current_period_end>GREATEST(NOW(),anchor)
       AND s.starts_at<paid_end AND COALESCE(p.is_addon,FALSE)=FALSE
       AND public.prepaid_lanes_overlap(COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin'),service)
  ) THEN
    IF NOT EXISTS(SELECT 1 FROM audit_log WHERE action='subscription.access_extension.recovery_owed' AND entity_id=p_source::text) THEN
      INSERT INTO audit_log(action,entity_type,entity_id,metadata)
      VALUES('subscription.access_extension.recovery_owed','subscription',p_source::text,
        jsonb_build_object('customerId',owner_id,'purchasedDays',days,'reason','conflicting_access_or_allowance'));
    END IF;
    RETURN NULL;
  END IF;

  INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,
    cancel_at_period_end,service_extension_days,commercial_snapshot,service_type_snapshot,
    plan_name_snapshot,plan_code_snapshot,price_minor_snapshot,currency_snapshot,
    billing_interval_snapshot,duration_days_snapshot,stremio_household_network_limit_snapshot,
    media_server_id,media_location_preference,media_location_snapshot,extension_recovery_of)
  VALUES(owner_id,parent.plan_id,'cancelled','manual','manual',anchor,anchor,TRUE,days,
    (parent.commercial_snapshot-ARRAY['checkoutIntentId','provider','providerMappingId','discountCodeId','discountedMinor',
      'serviceCreditMinor','serviceCreditCurrency','grossDiscountedMinor','extensionSubscriptionId'])
      ||jsonb_build_object('kind','recovered_access_extension','settlementKind','paid_extension_recovery','checkoutMode','payment'),
    service,parent.plan_name_snapshot,parent.plan_code_snapshot,parent.price_minor_snapshot,parent.currency_snapshot,
    parent.billing_interval_snapshot,parent.duration_days_snapshot,parent.stremio_household_network_limit_snapshot,
    parent.media_server_id,parent.media_location_preference,parent.media_location_snapshot,p_source)
  RETURNING id INTO recovered;

  UPDATE subscription_access_extensions e
     SET original_subscription_id=p_source,recovered_days=e.applied_days,subscription_id=recovered,updated_at=NOW()
   WHERE e.subscription_id=p_source AND e.status='active' AND e.applied_days>0
     AND e.customer_id=owner_id AND e.plan_id=parent.plan_id
     AND NOT EXISTS (
       SELECT 1 FROM payment_incidents pi
        WHERE pi.provider=e.provider AND pi.provider_subscription_id=e.provider_payment_id
          AND (pi.incident_type='chargeback' AND pi.incident_status='lost'
            OR pi.incident_type='refund' AND pi.metadata->>'fullRefund'='true')
     );
  INSERT INTO audit_log(action,entity_type,entity_id,metadata)
  VALUES('subscription.access_extension.recovered','subscription',recovered::text,
    jsonb_build_object('customerId',owner_id,'originalSubscriptionId',p_source,'purchasedDays',days));
  RETURN recovered;
END;
$$;

CREATE OR REPLACE FUNCTION reconcile_future_prepaid_full_refund()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refunded subscriptions%ROWTYPE;
  refunded_service text;
  removed_seconds numeric;
  recovery_id uuid;
  recovery_end timestamptz;
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

  recovery_id:=public.recover_independent_paid_extensions(refunded.id);
  SELECT s.current_period_end+make_interval(days=>s.service_extension_days)
    INTO recovery_end FROM subscriptions s WHERE s.id=recovery_id;
  IF recovery_end IS NOT NULL THEN
    removed_seconds:=GREATEST(0,EXTRACT(EPOCH FROM (
      refunded.current_period_end+make_interval(days=>refunded.service_extension_days)-recovery_end
    )));
  END IF;
  PERFORM public.pull_prepaid_queue(
    refunded.customer_id,refunded_service,refunded.current_period_end,removed_seconds,refunded.id,recovery_end
  );

  RETURN NEW;
END;
$$;

DO $grant$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['steamfusion_app','steamfusion_automation'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE 'GRANT EXECUTE ON FUNCTION public.recover_independent_paid_extensions(uuid) TO '||quote_ident(role_name);
    END IF;
  END LOOP;
END
$grant$;
COMMIT;
