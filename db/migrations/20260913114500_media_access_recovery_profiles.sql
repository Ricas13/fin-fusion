BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_media_access_recovery (
    customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    service_type text NOT NULL,
    access_lane text NOT NULL DEFAULT 'primary',
    preferred_username text,
    encrypted_password text,
    password_saved_at timestamptz,
    last_account_id uuid,
    last_remote_user_id text,
    last_server_id uuid REFERENCES public.jellyfin_servers(id) ON DELETE SET NULL,
    selected_library_names text[],
    removal_history jsonb NOT NULL DEFAULT '[]'::jsonb,
    removed_at timestamptz,
    removal_reason text,
    last_restored_at timestamptz,
    restore_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY(customer_id,service_type,access_lane),
    CONSTRAINT customer_media_access_recovery_service_check
        CHECK (service_type IN ('jellyfin','emby')),
    CONSTRAINT customer_media_access_recovery_lane_check
        CHECK (access_lane IN ('primary','free')),
    CONSTRAINT customer_media_access_recovery_restore_count_check
        CHECK (restore_count >= 0),
    CONSTRAINT customer_media_access_recovery_history_check
        CHECK (jsonb_typeof(removal_history)='array')
);

CREATE INDEX IF NOT EXISTS customer_media_access_recovery_removed_idx
    ON public.customer_media_access_recovery(removed_at DESC)
    WHERE removed_at IS NOT NULL;

COMMENT ON TABLE public.customer_media_access_recovery IS
    'Dormant media-access recovery state retained across entitlement/inactivity removal and deleted only with the owning customer.';
COMMENT ON COLUMN public.customer_media_access_recovery.encrypted_password IS
    'AES-GCM ciphertext produced by the application DATA_ENCRYPTION_KEY. Never plaintext and never returned through normal APIs.';
COMMENT ON COLUMN public.customer_media_access_recovery.removal_history IS
    'Append-only compact history of retired remote identities and reasons. Current subscriptions/customer state remain authoritative elsewhere.';

-- Preserve account-scoped state before any normal jellyfin_accounts deletion,
-- including inactivity, cancellation/refund reconciliation and remote-missing repair.
-- A hard customer deletion is intentionally different: once the parent customer
-- row is gone, skip snapshotting so ON DELETE CASCADE remains the sole purge path
-- and the trigger cannot reintroduce recovery data during the delete cascade.
CREATE OR REPLACE FUNCTION public.snapshot_media_access_before_account_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_service text;
    v_selected text[];
BEGIN
    IF OLD.account_purpose IS DISTINCT FROM 'jellyfin' THEN
        RETURN OLD;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id=OLD.customer_id) THEN
        RETURN OLD;
    END IF;

    SELECT COALESCE(media_server_type,'jellyfin')
      INTO v_service
      FROM public.jellyfin_servers
     WHERE id=OLD.server_id;

    v_service := COALESCE(v_service,'jellyfin');
    IF v_service NOT IN ('jellyfin','emby') THEN
        RETURN OLD;
    END IF;

    SELECT selected_names
      INTO v_selected
      FROM public.customer_jellyfin_library_selection
     WHERE customer_id=OLD.customer_id
       AND jellyfin_account_id=OLD.id
     LIMIT 1;

    INSERT INTO public.customer_media_access_recovery(
        customer_id,service_type,access_lane,preferred_username,
        last_account_id,last_remote_user_id,last_server_id,
        selected_library_names,removed_at,removal_reason,removal_history,updated_at
    ) VALUES (
        OLD.customer_id,v_service,COALESCE(OLD.access_lane,'primary'),OLD.jellyfin_username,
        OLD.id,OLD.jellyfin_user_id,OLD.server_id,
        v_selected,NOW(),'Media account removed',
        jsonb_build_array(jsonb_build_object(
            'accountId',OLD.id,
            'remoteUserId',OLD.jellyfin_user_id,
            'serverId',OLD.server_id,
            'username',OLD.jellyfin_username,
            'removedAt',NOW()
        )),NOW()
    )
    ON CONFLICT(customer_id,service_type,access_lane) DO UPDATE SET
        preferred_username=EXCLUDED.preferred_username,
        last_account_id=EXCLUDED.last_account_id,
        last_remote_user_id=EXCLUDED.last_remote_user_id,
        last_server_id=EXCLUDED.last_server_id,
        selected_library_names=COALESCE(EXCLUDED.selected_library_names,customer_media_access_recovery.selected_library_names),
        removed_at=EXCLUDED.removed_at,
        removal_reason=EXCLUDED.removal_reason,
        removal_history=(customer_media_access_recovery.removal_history || EXCLUDED.removal_history),
        updated_at=NOW();

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS jellyfin_accounts_media_recovery_snapshot ON public.jellyfin_accounts;
CREATE TRIGGER jellyfin_accounts_media_recovery_snapshot
BEFORE DELETE ON public.jellyfin_accounts
FOR EACH ROW
EXECUTE FUNCTION public.snapshot_media_access_before_account_delete();

COMMIT;
