BEGIN;

-- Emby Shares are an independent primary service lane. Historical bundles
-- continue to mean Jellyfin + Stremio only and must not overlap Emby.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid=con.conrelid
    JOIN pg_namespace nsp ON nsp.oid=rel.relnamespace
    WHERE nsp.nspname='public' AND rel.relname='plans' AND con.contype='c'
      AND lower(pg_get_constraintdef(con.oid)) LIKE '%service_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.plans DROP CONSTRAINT IF EXISTS %I',rec.conname);
  END LOOP;
END $$;

ALTER TABLE public.plans
  ADD CONSTRAINT plans_service_type_check
  CHECK (service_type IN ('jellyfin','stremio','emby','bundle'));

ALTER TABLE public.provisioning_runs
  DROP CONSTRAINT IF EXISTS provisioning_runs_action_check;

ALTER TABLE public.provisioning_runs
  ADD CONSTRAINT provisioning_runs_action_check
  CHECK (action IN (
    'provision','reconcile','disable','password_reset',
    'jellyfin_reconcile','jellyfin_disable','emby_reconcile','emby_disable'
  ));

CREATE OR REPLACE VIEW public.effective_emby_entitlements AS
 SELECT DISTINCT ON (s.customer_id)
    s.customer_id,s.id AS subscription_id,s.plan_id,s.status,s.source,s.starts_at,s.current_period_end,
    CASE WHEN (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
         THEN 'infinity'::timestamptz
         ELSE (s.current_period_end + ((COALESCE(s.service_extension_days,0) || ' days')::interval)) END AS access_expires_at,
    s.cancel_at_period_end,s.provider_customer_id,s.provider_subscription_id,
    public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked,
    s.service_type_snapshot,p.service_type,p.is_addon,p.is_free_tier,p.name,p.code,p.streams
 FROM subscriptions s
 JOIN plans p ON p.id=s.plan_id
 LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
 WHERE COALESCE(p.is_addon,FALSE)=FALSE
   AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin')='emby'
   AND s.superseded_by IS NULL AND s.starts_at<=NOW()
   AND ((o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
      OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
      OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN ('active','trialing','past_due','paused','cancelled','expired') AND (s.current_period_end + ((s.service_extension_days || ' days')::interval))>NOW()))
 ORDER BY s.customer_id,
   public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) ASC,
   (CASE WHEN (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
         THEN 'infinity'::timestamptz
         ELSE (s.current_period_end + ((COALESCE(s.service_extension_days,0) || ' days')::interval)) END) DESC,
   s.created_at DESC;

COMMENT ON VIEW public.effective_emby_entitlements IS
  'Effective standalone Emby Share primary entitlement, independent of Jellyfin and Stremio access.';

CREATE OR REPLACE FUNCTION public.enforce_single_live_customer_recurring_subscription() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    new_is_addon BOOLEAN := FALSE;
    new_service TEXT := 'jellyfin';
BEGIN
    IF NEW.superseded_by IS NULL
       AND NEW.source IN ('stripe','paypal')
       AND NEW.status IN ('active','trialing','past_due','paused')
       AND NEW.current_period_end > NOW()
       AND ((NEW.source='stripe' AND LEFT(COALESCE(NEW.provider_subscription_id,''),4)='sub_')
         OR (NEW.source='paypal' AND LEFT(COALESCE(NEW.provider_subscription_id,''),2)='I-')) THEN
        SELECT COALESCE(p.is_addon,FALSE),COALESCE(NULLIF(NEW.service_type_snapshot,''),NULLIF(p.service_type,''),'jellyfin')
          INTO new_is_addon,new_service FROM plans p WHERE p.id=NEW.plan_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
        IF new_is_addon THEN
            IF EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id=NEW.customer_id AND s.id<>NEW.id AND s.plan_id=NEW.plan_id
                  AND s.superseded_by IS NULL AND s.source IN ('stripe','paypal')
                  AND s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW()
                  AND ((s.source='stripe' AND LEFT(COALESCE(s.provider_subscription_id,''),4)='sub_') OR (s.source='paypal' AND LEFT(COALESCE(s.provider_subscription_id,''),2)='I-')))
            THEN RAISE EXCEPTION 'Customer already has a live recurring subscription for this add-on'; END IF;
        ELSIF EXISTS (
            SELECT 1 FROM subscriptions s JOIN plans existing_plan ON existing_plan.id=s.plan_id
            WHERE s.customer_id=NEW.customer_id AND s.id<>NEW.id AND COALESCE(existing_plan.is_addon,FALSE)=FALSE
              AND s.superseded_by IS NULL AND s.source IN ('stripe','paypal')
              AND s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW()
              AND ((s.source='stripe' AND LEFT(COALESCE(s.provider_subscription_id,''),4)='sub_') OR (s.source='paypal' AND LEFT(COALESCE(s.provider_subscription_id,''),2)='I-'))
              AND (COALESCE(NULLIF(s.service_type_snapshot,''),NULLIF(existing_plan.service_type,''),'jellyfin')=new_service
                OR (new_service='bundle' AND COALESCE(NULLIF(s.service_type_snapshot,''),NULLIF(existing_plan.service_type,''),'jellyfin') IN ('jellyfin','stremio','bundle'))
                OR (COALESCE(NULLIF(s.service_type_snapshot,''),NULLIF(existing_plan.service_type,''),'jellyfin')='bundle' AND new_service IN ('jellyfin','stremio','bundle'))))
        THEN RAISE EXCEPTION 'Customer already has a live recurring subscription for an overlapping service'; END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
