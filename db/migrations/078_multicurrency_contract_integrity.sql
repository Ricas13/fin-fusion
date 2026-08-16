BEGIN;

-- Prevent a provider mapping from naming one logical plan while pointing at a
-- price variant belonging to another plan.
CREATE UNIQUE INDEX IF NOT EXISTS plan_prices_id_plan_unique
    ON plan_prices(id,plan_id);
ALTER TABLE plan_provider_prices DROP CONSTRAINT IF EXISTS plan_provider_prices_price_plan_fk;
ALTER TABLE plan_provider_prices ADD CONSTRAINT plan_provider_prices_price_plan_fk
    FOREIGN KEY(plan_price_id,plan_id) REFERENCES plan_prices(id,plan_id) ON DELETE CASCADE;

-- Persist the selected catalogue price and mapping identifiers alongside the
-- existing immutable commercial JSON. These columns are reporting/audit aids;
-- the commercial_snapshot remains the authoritative checkout contract.
CREATE OR REPLACE FUNCTION snapshot_subscription_multicurrency_contract()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    price_text TEXT;
    mapping_text TEXT;
BEGIN
    IF NEW.commercial_snapshot IS NOT NULL AND jsonb_typeof(NEW.commercial_snapshot)='object' THEN
        price_text := NEW.commercial_snapshot->>'planPriceId';
        mapping_text := NEW.commercial_snapshot->>'providerMappingRecordId';
        IF NEW.plan_price_id_snapshot IS NULL AND price_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
            NEW.plan_price_id_snapshot := price_text::uuid;
        END IF;
        IF NEW.provider_mapping_id_snapshot IS NULL AND mapping_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
            NEW.provider_mapping_id_snapshot := mapping_text::uuid;
        END IF;
        NEW.provider_mapping_external_id_snapshot := COALESCE(
            NEW.provider_mapping_external_id_snapshot,
            NULLIF(NEW.commercial_snapshot->>'providerMappingId',''),
            NEW.provider_price_id_snapshot
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_multicurrency_contract_snapshot ON subscriptions;
CREATE TRIGGER subscriptions_multicurrency_contract_snapshot
BEFORE INSERT OR UPDATE OF commercial_snapshot,provider_price_id_snapshot ON subscriptions
FOR EACH ROW EXECUTE FUNCTION snapshot_subscription_multicurrency_contract();

-- Backfill the richer snapshot fields where historical commercial snapshots
-- already contain them. Invalid/missing values remain NULL rather than guessing.
UPDATE subscriptions
SET plan_price_id_snapshot=CASE
        WHEN plan_price_id_snapshot IS NULL AND (commercial_snapshot->>'planPriceId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (commercial_snapshot->>'planPriceId')::uuid ELSE plan_price_id_snapshot END,
    provider_mapping_id_snapshot=CASE
        WHEN provider_mapping_id_snapshot IS NULL AND (commercial_snapshot->>'providerMappingRecordId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (commercial_snapshot->>'providerMappingRecordId')::uuid ELSE provider_mapping_id_snapshot END,
    provider_mapping_external_id_snapshot=COALESCE(provider_mapping_external_id_snapshot,NULLIF(commercial_snapshot->>'providerMappingId',''),provider_price_id_snapshot)
WHERE commercial_snapshot IS NOT NULL AND jsonb_typeof(commercial_snapshot)='object';

COMMIT;
