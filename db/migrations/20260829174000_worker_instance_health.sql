ALTER TABLE public.operational_worker_state
    DROP CONSTRAINT IF EXISTS operational_worker_state_pkey;

ALTER TABLE public.operational_worker_state
    ADD CONSTRAINT operational_worker_state_pkey PRIMARY KEY(worker_key, instance_id);

CREATE INDEX IF NOT EXISTS idx_operational_worker_state_worker_heartbeat
    ON public.operational_worker_state(worker_key, last_heartbeat_at DESC);

CREATE OR REPLACE FUNCTION public.prune_operational_worker_instances(
    p_stale_after interval DEFAULT interval '24 hours'
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_deleted integer := 0;
BEGIN
    DELETE FROM public.operational_worker_state
    WHERE last_heartbeat_at < NOW() - GREATEST(COALESCE(p_stale_after, interval '24 hours'), interval '10 minutes');
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_operational_worker_instances(interval) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.record_activity_worker_heartbeat(
    p_instance_id text,
    p_version text,
    p_commit_sha text,
    p_draining boolean,
    p_metadata jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_instance_id text := LEFT(COALESCE(NULLIF(p_instance_id,''),'activity-unknown'),200);
BEGIN
    PERFORM public.prune_operational_worker_instances(interval '24 hours');

    INSERT INTO public.operational_worker_state(
        worker_key,instance_id,version,commit_sha,started_at,last_heartbeat_at,draining_at,metadata,updated_at
    ) VALUES(
        'activity',v_instance_id,NULLIF(LEFT(COALESCE(p_version,''),80),''),
        NULLIF(LEFT(COALESCE(p_commit_sha,''),80),''),NOW(),NOW(),CASE WHEN COALESCE(p_draining,FALSE) THEN NOW() ELSE NULL END,
        COALESCE(p_metadata,'{}'::jsonb),NOW()
    )
    ON CONFLICT(worker_key,instance_id) DO UPDATE SET
        version=EXCLUDED.version,
        commit_sha=EXCLUDED.commit_sha,
        last_heartbeat_at=NOW(),
        draining_at=CASE WHEN COALESCE(p_draining,FALSE) THEN COALESCE(public.operational_worker_state.draining_at,NOW()) ELSE NULL END,
        metadata=EXCLUDED.metadata,
        updated_at=NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.record_activity_worker_heartbeat(text,text,text,boolean,jsonb) FROM PUBLIC;
