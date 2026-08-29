BEGIN;

-- Financial history belongs to the affiliate who earned/spent it, not to the
-- referred customer whose purchase qualified the reward. The existing FK on
-- affiliate_credit_ledger.referred_customer_id is ON DELETE SET NULL, so the
-- safe deletion behavior is to preserve the ledger/allocation rows and let the
-- personal customer reference detach when the referred customer is removed.
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

    -- Do NOT delete affiliate_credit_ledger rows whose referred_customer_id is
    -- this customer. Those rows are economic history owned by another customer;
    -- the FK deliberately detaches referred_customer_id on customer deletion.
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
