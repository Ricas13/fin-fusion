BEGIN;

-- Reseller plans are monthly seat licences, but a logical tier may be sold in
-- several currencies just like customer/Stremio plans. Keep the legacy scalar
-- price on reseller_tiers as the compatibility/default price for snapshots and
-- old integrations; reseller_tier_prices is authoritative for new checkouts.
CREATE TABLE IF NOT EXISTS reseller_tier_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tier_id UUID NOT NULL REFERENCES reseller_tiers(id) ON DELETE CASCADE,
    currency CHAR(3) NOT NULL CHECK (currency IN ('GBP','USD','EUR')),
    price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tier_id,currency)
);
CREATE UNIQUE INDEX IF NOT EXISTS reseller_tier_prices_one_default_idx
    ON reseller_tier_prices(tier_id) WHERE is_default=TRUE;
CREATE INDEX IF NOT EXISTS reseller_tier_prices_sellable_idx
    ON reseller_tier_prices(tier_id,currency) WHERE active=TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS reseller_tier_prices_id_tier_unique
    ON reseller_tier_prices(id,tier_id);

INSERT INTO reseller_tier_prices(tier_id,currency,price_minor,active,is_default)
SELECT t.id,
       CASE WHEN t.currency IN ('GBP','USD','EUR') THEN t.currency ELSE 'GBP' END,
       t.monthly_price_minor,
       TRUE,
       TRUE
FROM reseller_tiers t
ON CONFLICT(tier_id,currency) DO NOTHING;

-- Provider mappings now belong to a concrete currency price. Existing mappings
-- are safely attached to the tier's current/default price.
ALTER TABLE reseller_tier_provider_prices
    ADD COLUMN IF NOT EXISTS tier_price_id UUID REFERENCES reseller_tier_prices(id) ON DELETE CASCADE;
UPDATE reseller_tier_provider_prices pp
SET tier_price_id=pr.id
FROM reseller_tier_prices pr
WHERE pr.tier_id=pp.tier_id
  AND pr.is_default=TRUE
  AND pp.tier_price_id IS NULL;
ALTER TABLE reseller_tier_provider_prices ALTER COLUMN tier_price_id SET NOT NULL;

ALTER TABLE reseller_tier_provider_prices DROP CONSTRAINT IF EXISTS reseller_tier_provider_prices_tier_id_provider_key;
DROP INDEX IF EXISTS reseller_tier_provider_prices_tier_id_provider_key;
CREATE UNIQUE INDEX IF NOT EXISTS reseller_tier_provider_prices_price_provider_unique
    ON reseller_tier_provider_prices(tier_price_id,provider);
ALTER TABLE reseller_tier_provider_prices DROP CONSTRAINT IF EXISTS reseller_tier_provider_prices_price_tier_fk;
ALTER TABLE reseller_tier_provider_prices ADD CONSTRAINT reseller_tier_provider_prices_price_tier_fk
    FOREIGN KEY(tier_price_id,tier_id) REFERENCES reseller_tier_prices(id,tier_id) ON DELETE CASCADE;

-- Record which currency variant/provider mapping created a reseller contract.
-- Existing commercial snapshot columns remain the authoritative historical
-- amount/currency; these IDs are audit/reporting helpers.
ALTER TABLE reseller_subscriptions
    ADD COLUMN IF NOT EXISTS tier_price_id_snapshot UUID,
    ADD COLUMN IF NOT EXISTS provider_mapping_id_snapshot UUID,
    ADD COLUMN IF NOT EXISTS provider_mapping_external_id_snapshot TEXT;

-- Ensure every tier has exactly one default variant and mirror it to the legacy
-- scalar columns so older readers remain coherent during rollout.
CREATE OR REPLACE FUNCTION sync_reseller_tier_default_price()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.is_default THEN
        UPDATE reseller_tier_prices
        SET is_default=FALSE,updated_at=NOW()
        WHERE tier_id=NEW.tier_id AND id<>NEW.id AND is_default=TRUE;
        UPDATE reseller_tiers
        SET monthly_price_minor=NEW.price_minor,currency=NEW.currency,updated_at=NOW()
        WHERE id=NEW.tier_id;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reseller_tier_default_price_sync ON reseller_tier_prices;
CREATE TRIGGER reseller_tier_default_price_sync
AFTER INSERT OR UPDATE OF price_minor,currency,is_default ON reseller_tier_prices
FOR EACH ROW EXECUTE FUNCTION sync_reseller_tier_default_price();

COMMIT;
