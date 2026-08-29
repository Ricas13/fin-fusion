BEGIN;

ALTER TABLE public.customer_deletion_jobs
    ADD COLUMN IF NOT EXISTS targets_persisted_at timestamptz;

CREATE TABLE IF NOT EXISTS public.customer_external_deletion_targets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    deletion_job_id uuid NOT NULL REFERENCES public.customer_deletion_jobs(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL,
    provider text NOT NULL,
    resource_type text NOT NULL,
    external_identifier text NOT NULL,
    desired_state text NOT NULL DEFAULT 'absent',
    state text NOT NULL DEFAULT 'pending',
    blocking boolean NOT NULL DEFAULT TRUE,
    attempt_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
    last_attempt_at timestamptz,
    last_error text,
    completed_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT customer_external_deletion_targets_state_check
        CHECK (state IN ('pending','running','failed','succeeded')),
    CONSTRAINT customer_external_deletion_targets_attempt_count_check
        CHECK (attempt_count >= 0),
    CONSTRAINT customer_external_deletion_targets_identity_key
        UNIQUE (deletion_job_id,provider,resource_type,external_identifier)
);

CREATE INDEX IF NOT EXISTS customer_external_deletion_targets_job_idx
    ON public.customer_external_deletion_targets(deletion_job_id,state,created_at);
CREATE INDEX IF NOT EXISTS customer_external_deletion_targets_due_idx
    ON public.customer_external_deletion_targets(state,next_attempt_at,created_at)
    WHERE state IN ('pending','running','failed');

COMMENT ON TABLE public.customer_external_deletion_targets IS
    'Durable per-resource tombstones for customer hard deletion. Rows deliberately reference the durable deletion job rather than the customer, so cleanup identity and failure state survive customer finalization.';
COMMENT ON COLUMN public.customer_external_deletion_targets.desired_state IS
    'Deletion convergence state. Jellyfin/Discord/Stremio use absent or revoked semantics; request-service users are retained for history but CAPTAiNFiN-managed permissions must converge to zero.';
COMMENT ON COLUMN public.customer_deletion_jobs.targets_persisted_at IS
    'Set only after the complete current external cleanup inventory has been durably snapshotted. Finalization is forbidden before this point.';

-- Strengthen the existing privileged finalizer. It still independently proves
-- every Jellyfin identity absent, and now also refuses to destroy canonical
-- customer identity while any blocking external cleanup target is incomplete.
CREATE OR REPLACE FUNCTION public.finalize_customer_deletion(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    j public.customer_deletion_jobs%ROWTYPE;
    expected_accounts integer := 0;
    confirmed_accounts integer := 0;
    deleted_accounts integer := 0;
    missing_accounts integer := 0;
    blocking_incomplete integer := 0;
    target_total integer := 0;
    effective_actor uuid;
    result_body jsonb;
BEGIN
    SELECT * INTO j
    FROM public.customer_deletion_jobs
    WHERE id=p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Customer deletion job not found';
    END IF;
    IF j.status <> 'running' THEN
        RAISE EXCEPTION 'Customer deletion job must be running before finalization';
    END IF;
    IF j.targets_persisted_at IS NULL THEN
        RAISE EXCEPTION 'External deletion targets have not been durably persisted';
    END IF;
    IF jsonb_typeof(j.jellyfin_results) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Customer deletion job has invalid Jellyfin results';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.customers WHERE id=j.customer_id) THEN
        RAISE EXCEPTION 'Customer disappeared before deletion could be finalized safely';
    END IF;

    SELECT COUNT(*)::integer,
           COUNT(*) FILTER (WHERE blocking AND state <> 'succeeded')::integer
    INTO target_total,blocking_incomplete
    FROM public.customer_external_deletion_targets
    WHERE deletion_job_id=j.id;

    IF COALESCE(blocking_incomplete,0) <> 0 THEN
        RAISE EXCEPTION 'External deletion cleanup is incomplete: % blocking target(s) remain', blocking_incomplete;
    END IF;

    SELECT COUNT(*)::integer INTO expected_accounts
    FROM public.jellyfin_accounts
    WHERE customer_id=j.customer_id;

    SELECT COUNT(DISTINCT e->>'accountId')::integer,
           COUNT(DISTINCT CASE WHEN e->>'status'='deleted' THEN e->>'accountId' END)::integer,
           COUNT(DISTINCT CASE WHEN e->>'status'='already_missing' THEN e->>'accountId' END)::integer
    INTO confirmed_accounts,deleted_accounts,missing_accounts
    FROM jsonb_array_elements(j.jellyfin_results) e
    WHERE e->>'status' IN ('deleted','already_missing')
      AND EXISTS(
          SELECT 1 FROM public.jellyfin_accounts ja
          WHERE ja.customer_id=j.customer_id
            AND ja.id::text=e->>'accountId'
      );

    IF COALESCE(confirmed_accounts,0) <> expected_accounts THEN
        RAISE EXCEPTION 'Remote Jellyfin deletion is incomplete: confirmed %, expected %', COALESCE(confirmed_accounts,0), expected_accounts;
    END IF;

    DELETE FROM public.jellyfin_accounts WHERE customer_id=j.customer_id;
    DELETE FROM public.content_requests WHERE customer_id=j.customer_id;
    DELETE FROM public.customer_bans
      WHERE customer_id=j.customer_id
         OR (j.customer_email IS NOT NULL AND normalized_email=LOWER(BTRIM(j.customer_email)));
    DELETE FROM public.customer_download_events WHERE customer_id=j.customer_id;
    DELETE FROM public.free_access_registration_reservations WHERE customer_id=j.customer_id;
    DELETE FROM public.payment_incidents WHERE customer_id=j.customer_id;
    DELETE FROM public.playback_history WHERE customer_id=j.customer_id;
    DELETE FROM public.stream_policy_events WHERE customer_id=j.customer_id;
    DELETE FROM public.affiliate_credit_ledger WHERE referred_customer_id=j.customer_id;

    DELETE FROM public.customers WHERE id=j.customer_id;
    IF j.user_id IS NOT NULL THEN
        DELETE FROM public.auth_events WHERE user_id=j.user_id;
        PERFORM set_config('steamfusion.allow_audit_mutation','on',true);
        BEGIN
            DELETE FROM public.app_users
            WHERE id=j.user_id
              AND role='customer'
              AND NOT EXISTS(SELECT 1 FROM public.customers WHERE user_id=j.user_id);
        EXCEPTION WHEN OTHERS THEN
            PERFORM set_config('steamfusion.allow_audit_mutation','off',true);
            RAISE;
        END;
        PERFORM set_config('steamfusion.allow_audit_mutation','off',true);
    END IF;

    SELECT id INTO effective_actor
    FROM public.app_users
    WHERE id=j.actor_user_id;

    result_body := jsonb_build_object(
        'customerId',j.customer_id,
        'name',j.customer_name,
        'email',j.customer_email,
        'deleted',true,
        'jobId',j.id,
        'externalTargets',target_total,
        'jellyfin',jsonb_build_object(
            'total',expected_accounts,
            'deleted',COALESCE(deleted_accounts,0),
            'alreadyMissing',COALESCE(missing_accounts,0),
            'results',j.jellyfin_results
        )
    );

    INSERT INTO public.audit_log(actor_user_id,action,entity_type,entity_id,metadata)
    VALUES(
        effective_actor,
        'admin.customer.hard_delete',
        'customer_deleted',
        j.customer_id::text,
        jsonb_build_object(
            'reason',j.reason,
            'deletionJobId',j.id,
            'externalTargets',target_total,
            'jellyfin',jsonb_build_object(
                'total',expected_accounts,
                'deleted',COALESCE(deleted_accounts,0),
                'alreadyMissing',COALESCE(missing_accounts,0)
            )
        )
    );

    UPDATE public.customer_deletion_jobs
    SET status='succeeded',completed_at=NOW(),last_error=NULL,
        result=result_body,updated_at=NOW()
    WHERE id=j.id;

    RETURN result_body;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_customer_deletion(uuid) FROM PUBLIC;

COMMIT;
