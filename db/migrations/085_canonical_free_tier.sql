BEGIN;

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS is_free_tier BOOLEAN NOT NULL DEFAULT FALSE;

-- Prefer an existing non-trial free Jellyfin product so production installs keep
-- their configured policy.  A clean install receives a safe, closed-by-default
-- free tier which the administrator can configure before opening capacity.
WITH candidate AS (
    SELECT id
    FROM plans
    WHERE archived_at IS NULL
      AND COALESCE(service_type,'jellyfin') IN ('jellyfin','bundle')
      AND billing_interval <> 'trial'
      AND price_minor = 0
    ORDER BY visible DESC,active DESC,sort_order,name,id
    LIMIT 1
)
UPDATE plans p
SET is_free_tier=TRUE,visible=TRUE,active=TRUE,price_minor=0,updated_at=NOW()
FROM candidate c
WHERE p.id=c.id;

INSERT INTO plans(
    code,name,description,audience,billing_interval,duration_days,
    price_minor,currency,streams,server_class,active,visible,sort_order,
    service_type,capacity_limit,is_free_tier
)
SELECT
    'free-access','Free Access',
    'Permanent free-access tier. Availability may be closed while the plan remains visible.',
    'direct','month',30,0,'GBP',1,'free',TRUE,TRUE,0,'jellyfin',0,TRUE
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE is_free_tier=TRUE)
ON CONFLICT(code) DO UPDATE
SET is_free_tier=TRUE,
    price_minor=0,
    active=TRUE,
    visible=TRUE,
    archived_at=NULL,
    updated_at=NOW();

CREATE UNIQUE INDEX IF NOT EXISTS plans_single_free_tier_idx
    ON plans((is_free_tier)) WHERE is_free_tier=TRUE;

-- The free tier must render in every supported storefront currency.  Zero is a
-- real price, not a missing-price fallback.
INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default)
SELECT p.id,c.currency,0,TRUE,(c.currency='GBP')
FROM plans p
CROSS JOIN (VALUES('GBP'::char(3)),('USD'::char(3)),('EUR'::char(3))) AS c(currency)
WHERE p.is_free_tier=TRUE
ON CONFLICT(plan_id,currency) DO UPDATE
SET price_minor=0,active=TRUE,updated_at=NOW();

UPDATE plan_prices pp
SET price_minor=0,active=TRUE,updated_at=NOW()
FROM plans p
WHERE pp.plan_id=p.id AND p.is_free_tier=TRUE;

CREATE OR REPLACE FUNCTION protect_canonical_free_tier()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        IF OLD.is_free_tier=TRUE THEN
            RAISE EXCEPTION 'The canonical free plan cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.is_free_tier=TRUE THEN
        IF NEW.is_free_tier<>TRUE
           OR NEW.active<>TRUE
           OR NEW.visible<>TRUE
           OR NEW.archived_at IS NOT NULL
           OR NEW.price_minor<>0
           OR NEW.billing_interval='trial' THEN
            RAISE EXCEPTION 'The canonical free plan must remain active, visible, non-trial and free';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_canonical_free_tier_trigger ON plans;
CREATE TRIGGER protect_canonical_free_tier_trigger
BEFORE UPDATE OR DELETE ON plans
FOR EACH ROW EXECUTE FUNCTION protect_canonical_free_tier();

CREATE OR REPLACE FUNCTION protect_canonical_free_tier_price()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE free_plan BOOLEAN;
BEGIN
    SELECT is_free_tier INTO free_plan FROM plans WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.plan_id ELSE NEW.plan_id END;
    IF free_plan=TRUE THEN
        IF TG_OP='DELETE' THEN
            RAISE EXCEPTION 'Free-tier storefront prices cannot be deleted';
        END IF;
        IF NEW.price_minor<>0 OR NEW.active<>TRUE THEN
            RAISE EXCEPTION 'Free-tier storefront prices must remain active and zero';
        END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_canonical_free_tier_price_trigger ON plan_prices;
CREATE TRIGGER protect_canonical_free_tier_price_trigger
BEFORE UPDATE OR DELETE ON plan_prices
FOR EACH ROW EXECUTE FUNCTION protect_canonical_free_tier_price();

COMMIT;
