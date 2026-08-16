BEGIN;

-- Legacy callers may still insert directly into plans and plan_provider_prices
-- using the pre-multicurrency shape. Keep those callers working while the new
-- application path explicitly selects a plan_prices row.

CREATE OR REPLACE FUNCTION ensure_plan_default_price_after_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    selected_currency CHAR(3);
BEGIN
    selected_currency := CASE
        WHEN UPPER(COALESCE(NEW.currency, 'GBP')) IN ('GBP','USD','EUR')
            THEN UPPER(COALESCE(NEW.currency, 'GBP'))::CHAR(3)
        ELSE 'GBP'::CHAR(3)
    END;

    INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default)
    VALUES(NEW.id,selected_currency,GREATEST(0,COALESCE(NEW.price_minor,0)),TRUE,TRUE)
    ON CONFLICT(plan_id,currency) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS plans_ensure_default_price_after_insert ON plans;
CREATE TRIGGER plans_ensure_default_price_after_insert
AFTER INSERT ON plans
FOR EACH ROW EXECUTE FUNCTION ensure_plan_default_price_after_insert();

CREATE OR REPLACE FUNCTION bind_legacy_provider_mapping_price()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    selected_price UUID;
    selected_currency CHAR(3);
    selected_minor INTEGER;
BEGIN
    IF NEW.plan_price_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT pr.id INTO selected_price
    FROM plan_prices pr
    WHERE pr.plan_id=NEW.plan_id
    ORDER BY pr.is_default DESC, pr.active DESC, pr.created_at ASC
    LIMIT 1;

    IF selected_price IS NULL THEN
        SELECT
            CASE
                WHEN UPPER(COALESCE(p.currency,'GBP')) IN ('GBP','USD','EUR')
                    THEN UPPER(COALESCE(p.currency,'GBP'))::CHAR(3)
                ELSE 'GBP'::CHAR(3)
            END,
            GREATEST(0,COALESCE(p.price_minor,0))
        INTO selected_currency, selected_minor
        FROM plans p
        WHERE p.id=NEW.plan_id;

        IF selected_currency IS NULL THEN
            RAISE EXCEPTION 'Provider mapping references unknown plan %', NEW.plan_id;
        END IF;

        INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default)
        VALUES(NEW.plan_id,selected_currency,selected_minor,TRUE,TRUE)
        ON CONFLICT(plan_id,currency) DO UPDATE
            SET updated_at=plan_prices.updated_at
        RETURNING id INTO selected_price;
    END IF;

    NEW.plan_price_id := selected_price;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS plan_provider_prices_bind_legacy_price ON plan_provider_prices;
CREATE TRIGGER plan_provider_prices_bind_legacy_price
BEFORE INSERT OR UPDATE OF plan_id,plan_price_id ON plan_provider_prices
FOR EACH ROW EXECUTE FUNCTION bind_legacy_provider_mapping_price();

COMMIT;
