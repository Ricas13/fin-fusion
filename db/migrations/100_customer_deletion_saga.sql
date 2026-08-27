BEGIN;

-- Hard deletion crosses PostgreSQL and one or more remote Jellyfin servers, so
-- it cannot be made atomic with a database transaction. Persist the operation
-- independently of the target customer so a failed/partial run can be retried
-- after remote users have already disappeared.
CREATE TABLE IF NOT EXISTS public.customer_deletion_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    user_id uuid,
    customer_name text,
    customer_email text,
    actor_user_id uuid,
    reason text NOT NULL DEFAULT 'Portal customer deleted by administrator',
    status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
    started_at timestamptz,
    access_held_at timestamptz,
    completed_at timestamptz,
    last_error text,
    jellyfin_results jsonb NOT NULL DEFAULT '[]'::jsonb,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT customer_deletion_jobs_status_check
        CHECK (status IN ('pending','running','failed','succeeded')),
    CONSTRAINT customer_deletion_jobs_attempt_count_check
        CHECK (attempt_count >= 0)
);

-- Only one unfinished deletion may own a customer. A completed job deliberately
-- keeps its snapshot/audit result after the customer and portal user are gone.
CREATE UNIQUE INDEX IF NOT EXISTS customer_deletion_jobs_one_active_customer_idx
    ON public.customer_deletion_jobs(customer_id)
    WHERE status IN ('pending','running','failed');

CREATE INDEX IF NOT EXISTS customer_deletion_jobs_due_idx
    ON public.customer_deletion_jobs(status,next_attempt_at,created_at)
    WHERE status IN ('pending','running','failed');

COMMENT ON TABLE public.customer_deletion_jobs IS
    'Durable cross-system customer hard-deletion saga. Target identifiers are snapshots rather than foreign keys so completed/failed operations survive target deletion.';
COMMENT ON COLUMN public.customer_deletion_jobs.jellyfin_results IS
    'Per-account remote deletion outcomes retained across retries. Local Jellyfin account rows are not removed until all remote identities are confirmed deleted or absent.';

-- The automation runtime deliberately cannot mutate app_users/auth_events. Give
-- it a single constrained finalizer instead of broadening those privileges.
-- This function refuses to delete portal data unless the running job contains a
-- successful remote outcome for every Jellyfin account that still exists
-- locally. All portal cleanup and job completion then happen in this one DB
-- transaction, so a failure leaves the local inventory available for retry.
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
    IF jsonb_typeof(j.jellyfin_results) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Customer deletion job has invalid Jellyfin results';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.customers WHERE id=j.customer_id) THEN
        RAISE EXCEPTION 'Customer disappeared before deletion could be finalized safely';
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

    -- Audit history is intentionally append-only. Existing actor references use
    -- ON DELETE SET NULL; the explicit compatibility guard below permits only
    -- the FK-driven cleanup caused by deleting the target portal user.
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
