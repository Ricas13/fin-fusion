-- Provider checkout IDs are external billing identities. Once a local checkout is
-- bound, another intent must never claim the same provider checkout and blank IDs
-- must not masquerade as a usable identity.

UPDATE billing_checkout_intents
SET provider_checkout_id = NULL,
    updated_at = NOW()
WHERE provider_checkout_id IS NOT NULL
  AND btrim(provider_checkout_id) = '';

DO $$
DECLARE duplicate_record RECORD;
BEGIN
    SELECT provider, provider_checkout_id, COUNT(*) AS n
      INTO duplicate_record
      FROM billing_checkout_intents
     WHERE provider_checkout_id IS NOT NULL
       AND btrim(provider_checkout_id) <> ''
     GROUP BY provider, provider_checkout_id
    HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'Duplicate provider checkout identity detected before uniqueness hardening: provider=%, checkout=%, rows=%',
            duplicate_record.provider,
            duplicate_record.provider_checkout_id,
            duplicate_record.n;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS billing_checkout_intents_provider_checkout_uidx
    ON billing_checkout_intents(provider, provider_checkout_id)
    WHERE provider_checkout_id IS NOT NULL AND btrim(provider_checkout_id) <> '';
