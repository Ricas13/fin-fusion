CREATE OR REPLACE FUNCTION public.record_activity_worker_heartbeat(
    p_instance_id text,
    p_version text,
    p_commit_sha text,
    p_draining boolean,
    p_metadata jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO operational_worker_state(
        worker_key,instance_id,version,commit_sha,started_at,last_heartbeat_at,draining_at,metadata,updated_at
    ) VALUES(
        'activity',LEFT(COALESCE(NULLIF(p_instance_id,''),'activity-unknown'),200),NULLIF(LEFT(COALESCE(p_version,''),80),''),
        NULLIF(LEFT(COALESCE(p_commit_sha,''),80),''),NOW(),NOW(),CASE WHEN COALESCE(p_draining,FALSE) THEN NOW() ELSE NULL END,
        COALESCE(p_metadata,'{}'::jsonb),NOW()
    )
    ON CONFLICT(worker_key) DO UPDATE SET
        instance_id=EXCLUDED.instance_id,
        version=EXCLUDED.version,
        commit_sha=EXCLUDED.commit_sha,
        last_heartbeat_at=NOW(),
        draining_at=CASE WHEN COALESCE(p_draining,FALSE) THEN COALESCE(operational_worker_state.draining_at,NOW()) ELSE NULL END,
        metadata=EXCLUDED.metadata,
        updated_at=NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.record_activity_worker_heartbeat(text,text,text,boolean,jsonb) FROM PUBLIC;
