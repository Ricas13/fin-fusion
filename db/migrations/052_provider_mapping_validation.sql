BEGIN;

ALTER TABLE reseller_tier_provider_prices
    ADD COLUMN IF NOT EXISTS validation_state TEXT NOT NULL DEFAULT 'unverified'
        CHECK (validation_state IN ('unverified','verified','failed')),
    ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS validation_error TEXT,
    ADD COLUMN IF NOT EXISTS validated_external_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Existing active mappings are grandfathered so this migration does not take
-- working commerce offline. Any subsequent provider-ID or checkout-mode edit
-- is reset to unverified by the triggers below and must be tested again.
UPDATE plan_provider_prices
SET validation_state='verified',validated_at=COALESCE(validated_at,updated_at,created_at,NOW())
WHERE active=TRUE AND validation_state='unverified';
UPDATE reseller_tier_provider_prices
SET validation_state='verified',validated_at=COALESCE(validated_at,updated_at,created_at,NOW())
WHERE active=TRUE AND validation_state='unverified';

CREATE OR REPLACE FUNCTION reset_direct_provider_mapping_validation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.external_id IS DISTINCT FROM OLD.external_id
       OR NEW.checkout_mode IS DISTINCT FROM OLD.checkout_mode THEN
        NEW.validation_state := 'unverified';
        NEW.validated_at := NULL;
        NEW.validation_error := NULL;
        NEW.validated_external_snapshot := '{}'::jsonb;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_reset_direct_provider_mapping_validation ON plan_provider_prices;
CREATE TRIGGER trg_reset_direct_provider_mapping_validation
BEFORE INSERT OR UPDATE OF provider,external_id,checkout_mode ON plan_provider_prices
FOR EACH ROW EXECUTE FUNCTION reset_direct_provider_mapping_validation();

CREATE OR REPLACE FUNCTION reset_reseller_provider_mapping_validation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
        NEW.validation_state := 'unverified';
        NEW.validated_at := NULL;
        NEW.validation_error := NULL;
        NEW.validated_external_snapshot := '{}'::jsonb;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_reset_reseller_provider_mapping_validation ON reseller_tier_provider_prices;
CREATE TRIGGER trg_reset_reseller_provider_mapping_validation
BEFORE INSERT OR UPDATE OF provider,external_id ON reseller_tier_provider_prices
FOR EACH ROW EXECUTE FUNCTION reset_reseller_provider_mapping_validation();

COMMIT;
