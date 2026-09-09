BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Retire the pre-state-machine recurring-subscription trigger.
-- ---------------------------------------------------------------------------
-- 20260909140000_state_machine_invariants.sql installed the canonical,
-- advisory-lock-based recurring service-lane invariant. The older trigger can
-- fire first alphabetically and reject a legitimate money-loss normalization
-- write before subscriptions_money_loss_terminal has made the row terminal.
DROP TRIGGER IF EXISTS single_live_customer_recurring_subscription_trigger ON public.subscriptions;
DROP FUNCTION IF EXISTS public.enforce_single_live_customer_recurring_subscription();

-- ---------------------------------------------------------------------------
-- 2. Keep legacy/global policy overrides converged with canonical lane policy.
-- ---------------------------------------------------------------------------
-- customer_lane_policy_overrides is authoritative. Legacy callers still exist
-- in a few admin/bulk surfaces, so make the compatibility table a faithful
-- primary-lane mirror until those callers are fully retired.
INSERT INTO public.customer_lane_policy_overrides(
    customer_id,access_lane,streams,allow_downloads,allow_video_transcoding,
    allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,
    allow_remote_access,updated_by,updated_at
)
SELECT l.customer_id,'primary',l.streams,l.allow_downloads,l.allow_video_transcoding,
       l.allow_audio_transcoding,l.allow_remuxing,l.allow_live_tv,l.allow_live_tv_management,
       l.allow_remote_access,l.updated_by,l.updated_at
FROM public.customer_policy_overrides l
WHERE NOT EXISTS (
    SELECT 1 FROM public.customer_lane_policy_overrides c
    WHERE c.customer_id=l.customer_id AND c.access_lane='primary'
)
ON CONFLICT(customer_id,access_lane) DO NOTHING;

INSERT INTO public.customer_policy_overrides(
    customer_id,streams,allow_downloads,allow_video_transcoding,
    allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,
    allow_remote_access,updated_by,updated_at
)
SELECT customer_id,streams,allow_downloads,allow_video_transcoding,
       allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,
       allow_remote_access,updated_by,updated_at
FROM public.customer_lane_policy_overrides
WHERE access_lane='primary'
ON CONFLICT(customer_id) DO UPDATE SET
    streams=EXCLUDED.streams,
    allow_downloads=EXCLUDED.allow_downloads,
    allow_video_transcoding=EXCLUDED.allow_video_transcoding,
    allow_audio_transcoding=EXCLUDED.allow_audio_transcoding,
    allow_remuxing=EXCLUDED.allow_remuxing,
    allow_live_tv=EXCLUDED.allow_live_tv,
    allow_live_tv_management=EXCLUDED.allow_live_tv_management,
    allow_remote_access=EXCLUDED.allow_remote_access,
    updated_by=EXCLUDED.updated_by,
    updated_at=EXCLUDED.updated_at;

CREATE OR REPLACE FUNCTION public.sync_primary_lane_policy_to_legacy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
    IF pg_trigger_depth()>1 THEN
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP='DELETE' THEN
        IF OLD.access_lane='primary' THEN
            DELETE FROM public.customer_policy_overrides WHERE customer_id=OLD.customer_id;
        END IF;
        RETURN OLD;
    END IF;
    IF NEW.access_lane<>'primary' THEN RETURN NEW; END IF;
    INSERT INTO public.customer_policy_overrides(
        customer_id,streams,allow_downloads,allow_video_transcoding,
        allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,
        allow_remote_access,updated_by,updated_at
    ) VALUES(
        NEW.customer_id,NEW.streams,NEW.allow_downloads,NEW.allow_video_transcoding,
        NEW.allow_audio_transcoding,NEW.allow_remuxing,NEW.allow_live_tv,NEW.allow_live_tv_management,
        NEW.allow_remote_access,NEW.updated_by,NEW.updated_at
    )
    ON CONFLICT(customer_id) DO UPDATE SET
        streams=EXCLUDED.streams,
        allow_downloads=EXCLUDED.allow_downloads,
        allow_video_transcoding=EXCLUDED.allow_video_transcoding,
        allow_audio_transcoding=EXCLUDED.allow_audio_transcoding,
        allow_remuxing=EXCLUDED.allow_remuxing,
        allow_live_tv=EXCLUDED.allow_live_tv,
        allow_live_tv_management=EXCLUDED.allow_live_tv_management,
        allow_remote_access=EXCLUDED.allow_remote_access,
        updated_by=EXCLUDED.updated_by,
        updated_at=EXCLUDED.updated_at;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_lane_policy_overrides_sync_legacy ON public.customer_lane_policy_overrides;
CREATE TRIGGER customer_lane_policy_overrides_sync_legacy
AFTER INSERT OR UPDATE OR DELETE ON public.customer_lane_policy_overrides
FOR EACH ROW EXECUTE FUNCTION public.sync_primary_lane_policy_to_legacy();

CREATE OR REPLACE FUNCTION public.sync_legacy_policy_to_primary_lane()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
    IF pg_trigger_depth()>1 THEN
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP='DELETE' THEN
        DELETE FROM public.customer_lane_policy_overrides
        WHERE customer_id=OLD.customer_id AND access_lane='primary';
        RETURN OLD;
    END IF;
    INSERT INTO public.customer_lane_policy_overrides(
        customer_id,access_lane,streams,allow_downloads,allow_video_transcoding,
        allow_audio_transcoding,allow_remuxing,allow_live_tv,allow_live_tv_management,
        allow_remote_access,updated_by,updated_at
    ) VALUES(
        NEW.customer_id,'primary',NEW.streams,NEW.allow_downloads,NEW.allow_video_transcoding,
        NEW.allow_audio_transcoding,NEW.allow_remuxing,NEW.allow_live_tv,NEW.allow_live_tv_management,
        NEW.allow_remote_access,NEW.updated_by,NEW.updated_at
    )
    ON CONFLICT(customer_id,access_lane) DO UPDATE SET
        streams=EXCLUDED.streams,
        allow_downloads=EXCLUDED.allow_downloads,
        allow_video_transcoding=EXCLUDED.allow_video_transcoding,
        allow_audio_transcoding=EXCLUDED.allow_audio_transcoding,
        allow_remuxing=EXCLUDED.allow_remuxing,
        allow_live_tv=EXCLUDED.allow_live_tv,
        allow_live_tv_management=EXCLUDED.allow_live_tv_management,
        allow_remote_access=EXCLUDED.allow_remote_access,
        updated_by=EXCLUDED.updated_by,
        updated_at=EXCLUDED.updated_at;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_policy_overrides_sync_primary_lane ON public.customer_policy_overrides;
CREATE TRIGGER customer_policy_overrides_sync_primary_lane
AFTER INSERT OR UPDATE OR DELETE ON public.customer_policy_overrides
FOR EACH ROW EXECUTE FUNCTION public.sync_legacy_policy_to_primary_lane();

-- ---------------------------------------------------------------------------
-- 3. Keep deprecated Jellyfin-only admin control readable without stale state.
-- ---------------------------------------------------------------------------
-- The canonical authority is customer_service_admin_control. Some bulk-list
-- metrics still read the one-release rollback table, so keep that compatibility
-- table rebuilt from the canonical Jellyfin directive until the read is retired.
INSERT INTO public.customer_service_admin_control(
    customer_id,service,mode,server_id,reason,created_by,created_at,updated_by,updated_at
)
SELECT DISTINCT ON(l.customer_id)
    l.customer_id,'jellyfin',
    CASE l.mode WHEN 'forced_server' THEN 'admin_server_pin' ELSE 'admin_removed' END,
    l.server_id,l.reason,l.created_by,l.created_at,l.updated_by,l.updated_at
FROM public.customer_jellyfin_admin_control l
WHERE NOT EXISTS (
    SELECT 1 FROM public.customer_service_admin_control c
    WHERE c.customer_id=l.customer_id AND c.service='jellyfin'
)
ORDER BY l.customer_id,l.updated_at DESC
ON CONFLICT(customer_id,service) DO NOTHING;

CREATE OR REPLACE FUNCTION public.refresh_legacy_jellyfin_admin_control(p_customer_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
    ctrl public.customer_service_admin_control%ROWTYPE;
    sub_id uuid;
BEGIN
    DELETE FROM public.customer_jellyfin_admin_control WHERE customer_id=p_customer_id;
    SELECT * INTO ctrl
    FROM public.customer_service_admin_control
    WHERE customer_id=p_customer_id AND service='jellyfin';
    IF NOT FOUND OR ctrl.mode='admin_present' THEN RETURN; END IF;

    SELECT s.id INTO sub_id
    FROM public.subscriptions s
    JOIN public.plans p ON p.id=s.plan_id
    WHERE s.customer_id=p_customer_id
      AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
    ORDER BY s.created_at DESC,s.id DESC
    LIMIT 1;
    IF sub_id IS NULL THEN RETURN; END IF;

    INSERT INTO public.customer_jellyfin_admin_control(
        customer_id,subscription_id,mode,server_id,reason,
        created_by,created_at,updated_by,updated_at
    ) VALUES(
        p_customer_id,sub_id,
        CASE ctrl.mode WHEN 'admin_server_pin' THEN 'forced_server' ELSE 'removed' END,
        ctrl.server_id,ctrl.reason,ctrl.created_by,ctrl.created_at,ctrl.updated_by,ctrl.updated_at
    );
END;
$$;

DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT DISTINCT customer_id FROM public.customer_service_admin_control WHERE service='jellyfin'
    LOOP
        PERFORM public.refresh_legacy_jellyfin_admin_control(r.customer_id);
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.sync_service_admin_control_legacy_jellyfin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        IF OLD.service='jellyfin' THEN PERFORM public.refresh_legacy_jellyfin_admin_control(OLD.customer_id); END IF;
        RETURN OLD;
    END IF;
    IF TG_OP='UPDATE' AND OLD.service='jellyfin' AND (OLD.customer_id IS DISTINCT FROM NEW.customer_id OR NEW.service<>'jellyfin') THEN
        PERFORM public.refresh_legacy_jellyfin_admin_control(OLD.customer_id);
    END IF;
    IF NEW.service='jellyfin' THEN PERFORM public.refresh_legacy_jellyfin_admin_control(NEW.customer_id); END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_service_admin_control_sync_legacy_jellyfin ON public.customer_service_admin_control;
CREATE TRIGGER customer_service_admin_control_sync_legacy_jellyfin
AFTER INSERT OR UPDATE OR DELETE ON public.customer_service_admin_control
FOR EACH ROW EXECUTE FUNCTION public.sync_service_admin_control_legacy_jellyfin();

-- ---------------------------------------------------------------------------
-- 4. Hot-path supporting indexes.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS active_playback_sessions_jellyfin_account_idx
    ON public.active_playback_sessions(jellyfin_account_id);
CREATE INDEX IF NOT EXISTS stremio_managed_accounts_jellyfin_account_idx
    ON public.stremio_managed_accounts(jellyfin_account_id);

COMMIT;
