ALTER TABLE public.stremio_entitlements
  ADD COLUMN IF NOT EXISTS token_hash_aliases text[] NOT NULL DEFAULT '{}'::text[];

CREATE INDEX IF NOT EXISTS stremio_entitlements_token_hash_aliases_gin
  ON public.stremio_entitlements USING gin (token_hash_aliases);

COMMENT ON COLUMN public.stremio_entitlements.token_hash_aliases IS
  'Bounded historical SHA-256 install-token hashes preserved only when automatic portal recovery replaces an unrecoverable token during the same continuously-entitled term. Explicit rotation, revoke, suspension and entitlement end clear them.';

-- Migration 20260909111500 established the security invariant that install
-- credentials cannot revive across an entitlement suspension/end. Automatic
-- recovery aliases are part of that credential set and must obey the same
-- boundary.
CREATE OR REPLACE FUNCTION public.rotate_stremio_install_credential_on_suspend()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.status = 'active'
       AND NEW.status <> 'active'
       AND (
         OLD.token_hash IS NOT NULL
         OR OLD.token_hint IS NOT NULL
         OR COALESCE(cardinality(OLD.token_hash_aliases),0) > 0
       ) THEN
        NEW.token_hash := NULL;
        NEW.token_hint := NULL;
        NEW.token_hash_aliases := '{}'::text[];
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

UPDATE public.stremio_entitlements
SET token_hash_aliases='{}'::text[],
    updated_at=NOW()
WHERE status<>'active'
  AND COALESCE(cardinality(token_hash_aliases),0)>0;
