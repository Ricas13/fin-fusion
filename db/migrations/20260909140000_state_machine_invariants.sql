BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Confirmed money loss is terminal for the exact provider settlement.
-- ---------------------------------------------------------------------------
-- #689 made refund termination durable through refund_terminated_at and barred
-- later service extensions. Keep the stronger rule at the database boundary:
-- any INSERT/UPDATE that refers to an exact provider payment/subscription which
-- already has confirmed full-refund/lost-chargeback evidence must remain
-- terminal. This closes both refund-before-activation and stale checkout replay.
CREATE OR REPLACE FUNCTION public.enforce_subscription_money_loss_terminal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    loss_at timestamptz;
BEGIN
    IF NEW.source IN ('stripe','paypal','plisio')
       AND NULLIF(BTRIM(COALESCE(NEW.provider_subscription_id,'')),'') IS NOT NULL THEN
        SELECT pi.created_at
          INTO loss_at
          FROM public.payment_incidents pi
         WHERE pi.provider=NEW.source
           AND pi.provider_subscription_id=NEW.provider_subscription_id
           AND (
               (pi.incident_type='refund' AND COALESCE(pi.metadata->>'fullRefund','false')='true')
               OR (pi.incident_type='chargeback' AND pi.incident_status='lost')
           )
         ORDER BY pi.created_at DESC,pi.id DESC
         LIMIT 1;
    END IF;

    IF (TG_OP='UPDATE' AND OLD.refund_terminated_at IS NOT NULL)
       OR NEW.refund_terminated_at IS NOT NULL
       OR loss_at IS NOT NULL THEN
        NEW.refund_terminated_at := COALESCE(
            CASE WHEN TG_OP='UPDATE' THEN OLD.refund_terminated_at ELSE NULL END,
            NEW.refund_terminated_at,
            loss_at,
            NOW()
        );
        NEW.status := 'cancelled';
        NEW.current_period_end := LEAST(COALESCE(NEW.current_period_end,NOW()),NOW());
        NEW.service_extension_days := 0;
        NEW.cancel_at_period_end := TRUE;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_money_loss_terminal ON public.subscriptions;
CREATE TRIGGER subscriptions_money_loss_terminal
BEFORE INSERT OR UPDATE ON public.subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_subscription_money_loss_terminal();

-- Repair any row that was resurrected before this migration landed.
UPDATE public.subscriptions
SET status='cancelled',
    current_period_end=LEAST(COALESCE(current_period_end,NOW()),NOW()),
    service_extension_days=0,
    cancel_at_period_end=TRUE,
    updated_at=NOW()
WHERE refund_terminated_at IS NOT NULL
  AND (
      status IN ('active','trialing','past_due','paused')
      OR current_period_end>NOW()
      OR COALESCE(service_extension_days,0)<>0
  );

ALTER TABLE public.subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_refund_terminated_not_live_check;
ALTER TABLE public.subscriptions
    ADD CONSTRAINT subscriptions_refund_terminated_not_live_check
    CHECK (
        refund_terminated_at IS NULL
        OR (
            status NOT IN ('active','trialing','past_due','paused')
            AND COALESCE(service_extension_days,0)=0
        )
    );

-- ---------------------------------------------------------------------------
-- 2. At most one live recurring contract may own an overlapping service lane.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_single_live_recurring_service()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    target_is_addon boolean;
    target_service text;
    conflict_id uuid;
BEGIN
    IF NEW.source NOT IN ('stripe','paypal')
       OR COALESCE(NEW.billing_mode,'payment')<>'subscription'
       OR NEW.status NOT IN ('active','trialing','past_due','paused')
       OR NEW.current_period_end<=NOW()
       OR NEW.superseded_by IS NOT NULL
       OR NEW.refund_terminated_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- Serialize even writers that bypass the application-level customer row
    -- lock so two distinct provider subscription IDs cannot both win.
    PERFORM pg_advisory_xact_lock(823741,hashtext(NEW.customer_id::text));

    SELECT COALESCE(p.is_addon,FALSE),
           COALESCE(NULLIF(NEW.service_type_snapshot,''),p.service_type,'jellyfin')
      INTO target_is_addon,target_service
      FROM public.plans p
     WHERE p.id=NEW.plan_id;

    IF target_is_addon THEN
        SELECT s.id
          INTO conflict_id
          FROM public.subscriptions s
         WHERE s.customer_id=NEW.customer_id
           AND s.id<>NEW.id
           AND s.plan_id=NEW.plan_id
           AND s.superseded_by IS NULL
           AND s.source IN ('stripe','paypal')
           AND COALESCE(s.billing_mode,'payment')='subscription'
           AND s.status IN ('active','trialing','past_due','paused')
           AND s.current_period_end>NOW()
           AND s.refund_terminated_at IS NULL
         LIMIT 1;
    ELSE
        SELECT s.id
          INTO conflict_id
          FROM public.subscriptions s
          JOIN public.plans p ON p.id=s.plan_id
         WHERE s.customer_id=NEW.customer_id
           AND s.id<>NEW.id
           AND s.superseded_by IS NULL
           AND s.source IN ('stripe','paypal')
           AND COALESCE(s.billing_mode,'payment')='subscription'
           AND s.status IN ('active','trialing','past_due','paused')
           AND s.current_period_end>NOW()
           AND s.refund_terminated_at IS NULL
           AND COALESCE(p.is_addon,FALSE)=FALSE
           AND (
               COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin')=target_service
               OR (
                   target_service='bundle'
                   AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','stremio')
               )
               OR (
                   COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin')='bundle'
                   AND target_service IN ('jellyfin','stremio')
               )
           )
         LIMIT 1;
    END IF;

    IF conflict_id IS NOT NULL THEN
        RAISE EXCEPTION 'A live recurring subscription already owns this service lane.'
            USING ERRCODE='23505',
                  CONSTRAINT='subscriptions_single_live_recurring_service',
                  DETAIL='conflicting_subscription_id='||conflict_id::text;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_single_live_recurring_service ON public.subscriptions;
CREATE TRIGGER subscriptions_single_live_recurring_service
BEFORE INSERT OR UPDATE OF customer_id,plan_id,status,source,current_period_end,superseded_by,billing_mode,service_type_snapshot,refund_terminated_at
ON public.subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.enforce_single_live_recurring_service();

-- ---------------------------------------------------------------------------
-- 3. Preserve distinct administrative authority instead of one generic hold.
-- ---------------------------------------------------------------------------
-- Existing generic holds were produced by holdAccess(reason) collapsing every
-- non-disabled/non-suspended reason into admin_hold/source=admin. Reclassify the
-- two destructive reasons so routine Enable cannot release them.
UPDATE public.customer_access_holds
SET hold_type='administrative_ban',
    source_key=CASE WHEN source_key='admin' THEN 'ban' ELSE source_key END
WHERE released_at IS NULL
  AND hold_type='admin_hold'
  AND LOWER(COALESCE(reason,'')) LIKE '%ban%';

UPDATE public.customer_access_holds
SET hold_type='jellyfin_identity_removed',
    source_key=CASE WHEN source_key='admin' THEN 'identity-removal' ELSE source_key END
WHERE released_at IS NULL
  AND hold_type='admin_hold'
  AND (
      LOWER(COALESCE(reason,''))='jellyfin_deleted'
      OR LOWER(COALESCE(reason,'')) LIKE '%jellyfin%delete%'
      OR LOWER(COALESCE(reason,'')) LIKE '%jellyfin%removed%'
  );

-- ---------------------------------------------------------------------------
-- 4. Discord managed-role history survives plan remaps.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.discord_managed_role_history (
    role_id text PRIMARY KEY,
    first_seen_at timestamptz NOT NULL DEFAULT NOW(),
    last_seen_at timestamptz NOT NULL DEFAULT NOW(),
    retired_at timestamptz,
    last_plan_id uuid REFERENCES public.plans(id) ON DELETE SET NULL
);

INSERT INTO public.discord_managed_role_history(role_id,last_plan_id,retired_at)
SELECT DISTINCT ON (discord_role_id) discord_role_id,id,NULL
FROM public.plans
WHERE discord_role_id IS NOT NULL AND discord_role_id<>''
ORDER BY discord_role_id,updated_at DESC NULLS LAST,id
ON CONFLICT(role_id) DO UPDATE SET
    last_seen_at=NOW(),
    retired_at=NULL,
    last_plan_id=EXCLUDED.last_plan_id;

CREATE OR REPLACE FUNCTION public.capture_plan_discord_role_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP<>'INSERT' AND OLD.discord_role_id IS NOT NULL AND OLD.discord_role_id<>''
       AND (TG_OP='DELETE' OR OLD.discord_role_id IS DISTINCT FROM NEW.discord_role_id) THEN
        INSERT INTO public.discord_managed_role_history(role_id,last_seen_at,retired_at,last_plan_id)
        VALUES(
            OLD.discord_role_id,
            NOW(),
            NOW(),
            CASE WHEN TG_OP='DELETE' THEN NULL ELSE OLD.id END
        )
        ON CONFLICT(role_id) DO UPDATE SET
            last_seen_at=NOW(),
            retired_at=NOW(),
            last_plan_id=CASE WHEN TG_OP='DELETE' THEN NULL ELSE OLD.id END;
    END IF;

    IF TG_OP<>'DELETE' AND NEW.discord_role_id IS NOT NULL AND NEW.discord_role_id<>'' THEN
        INSERT INTO public.discord_managed_role_history(role_id,last_seen_at,retired_at,last_plan_id)
        VALUES(NEW.discord_role_id,NOW(),NULL,NEW.id)
        ON CONFLICT(role_id) DO UPDATE SET
            last_seen_at=NOW(),
            retired_at=NULL,
            last_plan_id=NEW.id;
    END IF;

    IF TG_OP='INSERT'
       OR TG_OP='DELETE'
       OR OLD.discord_role_id IS DISTINCT FROM NEW.discord_role_id THEN
        UPDATE public.automation_job_state
        SET next_run_at=NOW(),force_run_requested=TRUE,updated_at=NOW()
        WHERE job_key='discord_roles' AND enabled=TRUE;
    END IF;

    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS plans_capture_discord_role_history ON public.plans;
CREATE TRIGGER plans_capture_discord_role_history
AFTER INSERT OR UPDATE OF discord_role_id OR DELETE ON public.plans
FOR EACH ROW
EXECUTE FUNCTION public.capture_plan_discord_role_history();

COMMIT;
