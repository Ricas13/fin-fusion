BEGIN;

-- An install credential belongs to one continuously-entitled Stremio term.
-- When the entitlement leaves active state (expiry, refund, cancellation,
-- admin removal, etc.), invalidate the manifest token at the database boundary
-- so a later re-entitlement cannot silently revive the old credential.
CREATE OR REPLACE FUNCTION public.rotate_stremio_install_credential_on_suspend()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.status = 'active'
       AND NEW.status <> 'active'
       AND (OLD.token_hash IS NOT NULL OR OLD.token_hint IS NOT NULL) THEN
        NEW.token_hash := NULL;
        NEW.token_hint := NULL;
        NEW.install_issued_at := NULL;
        NEW.token_version := COALESCE(OLD.token_version, 0) + 1;

        DELETE FROM public.stremio_install_credential_recovery
        WHERE customer_id = OLD.customer_id
           OR entitlement_id = OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_stremio_install_credential_on_suspend() FROM PUBLIC;

DROP TRIGGER IF EXISTS stremio_entitlements_rotate_install_credential ON public.stremio_entitlements;
CREATE TRIGGER stremio_entitlements_rotate_install_credential
BEFORE UPDATE OF status ON public.stremio_entitlements
FOR EACH ROW
EXECUTE FUNCTION public.rotate_stremio_install_credential_on_suspend();

-- Clean up any credentials already left dormant by historical suspensions.
UPDATE public.stremio_entitlements
SET token_hash = NULL,
    token_hint = NULL,
    install_issued_at = NULL,
    token_version = COALESCE(token_version, 0) + 1,
    updated_at = NOW()
WHERE status <> 'active'
  AND (token_hash IS NOT NULL OR token_hint IS NOT NULL);

DELETE FROM public.stremio_install_credential_recovery r
USING public.stremio_entitlements e
WHERE e.id = r.entitlement_id
  AND e.status <> 'active';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.stremio_entitlements
        WHERE status <> 'active'
          AND (token_hash IS NOT NULL OR token_hint IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'inactive Stremio entitlements must not retain install credentials';
    END IF;
END;
$$;

COMMIT;
