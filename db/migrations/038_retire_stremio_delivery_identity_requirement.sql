BEGIN;

-- Current Stremio delivery is source-based. An active entitlement needs an
-- install credential, but it no longer needs an entitlement-level Jellyfin
-- server/account/token tuple. A complete legacy tuple is still accepted for
-- compatibility while incomplete attached identities remain invalid.
CREATE OR REPLACE FUNCTION public.enforce_stremio_entitlement_integrity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  sub_customer UUID;
  sub_service TEXT;
  account_customer UUID;
  account_server UUID;
  account_purpose_value TEXT;
  server_allowed BOOLEAN;
BEGIN
  SELECT customer_id,COALESCE(service_type_snapshot,'jellyfin')
    INTO sub_customer,sub_service FROM subscriptions WHERE id=NEW.subscription_id;
  IF sub_customer IS NULL OR sub_customer<>NEW.customer_id THEN RAISE EXCEPTION 'Stremio subscription/customer mismatch'; END IF;
  IF sub_service NOT IN ('stremio','bundle') THEN RAISE EXCEPTION 'Stremio entitlement requires a stremio or bundle subscription'; END IF;

  IF NEW.status<>'revoked' AND NEW.server_id IS NOT NULL THEN
    SELECT stremio_enabled INTO server_allowed FROM jellyfin_servers WHERE id=NEW.server_id;
    IF COALESCE(server_allowed,FALSE)=FALSE THEN RAISE EXCEPTION 'Assigned Jellyfin server is not enabled for Stremio'; END IF;
  END IF;

  IF NEW.jellyfin_account_id IS NOT NULL THEN
    SELECT customer_id,server_id,account_purpose INTO account_customer,account_server,account_purpose_value FROM jellyfin_accounts WHERE id=NEW.jellyfin_account_id;
    IF account_customer IS NULL OR account_customer<>NEW.customer_id OR account_server IS DISTINCT FROM NEW.server_id THEN RAISE EXCEPTION 'Stremio Jellyfin account ownership/server mismatch'; END IF;
    IF account_purpose_value<>'stremio_internal' THEN RAISE EXCEPTION 'Stremio entitlement requires a dedicated internal Jellyfin account'; END IF;
  END IF;

  IF NEW.status='active' AND NEW.token_hash IS NULL THEN
    RAISE EXCEPTION 'Active Stremio entitlement requires an install credential';
  END IF;

  IF NEW.status='active' AND (
       (NEW.server_id IS NULL) <> (NEW.jellyfin_account_id IS NULL)
       OR (NEW.server_id IS NULL) <> (NEW.jellyfin_access_token_encrypted IS NULL)
  ) THEN
    RAISE EXCEPTION 'Legacy managed Jellyfin delivery identity must be complete when attached to an active Stremio entitlement';
  END IF;

  IF NEW.status='revoked' AND NEW.revoked_at IS NULL THEN
    NEW.revoked_at:=NOW();
  ELSIF NEW.status<>'revoked' THEN
    NEW.revoked_at:=NULL;
  END IF;
  NEW.updated_at:=NOW();
  RETURN NEW;
END;
$$;

-- Migration 031 could only requeue the legacy failure if a currently-active
-- plan still looked exactly like a standalone Stremio plan. That left bundle,
-- expired/deprovisioning, restored-backup and later-created failures sticky.
-- The exact retired error is safe to requeue unconditionally: the current
-- service-aware reconciler will discover today's entitlement and settle the
-- customer into the correct active/suspended state.
UPDATE customer_provisioning_state
SET status='pending',
    consecutive_failures=0,
    last_error=NULL,
    next_attempt_at=NOW(),
    updated_at=NOW()
WHERE last_error LIKE '%Active Stremio entitlement requires either selected shared sources or a managed Jellyfin delivery identity%';

COMMIT;
