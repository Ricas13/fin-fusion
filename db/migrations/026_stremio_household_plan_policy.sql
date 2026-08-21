BEGIN;

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS stremio_household_network_limit INTEGER NOT NULL DEFAULT 1 CHECK (stremio_household_network_limit BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS stremio_ip_replacement_policy TEXT NOT NULL DEFAULT 'customer_cooldown' CHECK (stremio_ip_replacement_policy IN ('auto_inactive','customer_cooldown')),
  ADD COLUMN IF NOT EXISTS stremio_ip_replacement_cooldown_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (stremio_ip_replacement_cooldown_minutes BETWEEN 15 AND 1440);

-- Existing Stremio plans keep their current lease-driven replacement behaviour.
-- New plans use the safer customer-controlled 24-hour cooldown by default.
UPDATE plans
SET stremio_ip_replacement_policy='auto_inactive'
WHERE service_type IN ('stremio','bundle');

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS stremio_household_network_limit_snapshot INTEGER CHECK (stremio_household_network_limit_snapshot BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS stremio_ip_replacement_policy_snapshot TEXT CHECK (stremio_ip_replacement_policy_snapshot IN ('auto_inactive','customer_cooldown')),
  ADD COLUMN IF NOT EXISTS stremio_ip_replacement_cooldown_minutes_snapshot INTEGER CHECK (stremio_ip_replacement_cooldown_minutes_snapshot BETWEEN 15 AND 1440);

-- Freeze the policy currently experienced by existing Stremio customers. This
-- lets later plan edits safely distinguish "new purchases only" from changes
-- that should be applied to existing subscriptions too.
UPDATE subscriptions s
SET stremio_household_network_limit_snapshot=p.stremio_household_network_limit,
    stremio_ip_replacement_policy_snapshot=p.stremio_ip_replacement_policy,
    stremio_ip_replacement_cooldown_minutes_snapshot=p.stremio_ip_replacement_cooldown_minutes
FROM plans p
WHERE p.id=s.plan_id
  AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('stremio','bundle')
  AND s.stremio_household_network_limit_snapshot IS NULL;

CREATE OR REPLACE FUNCTION snapshot_subscription_stremio_household_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p plans%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' OR NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
    SELECT * INTO p FROM plans WHERE id=NEW.plan_id;
    IF FOUND AND p.service_type IN ('stremio','bundle') THEN
      IF TG_OP='INSERT' THEN
        NEW.stremio_household_network_limit_snapshot := COALESCE(NEW.stremio_household_network_limit_snapshot,p.stremio_household_network_limit);
        NEW.stremio_ip_replacement_policy_snapshot := COALESCE(NEW.stremio_ip_replacement_policy_snapshot,p.stremio_ip_replacement_policy);
        NEW.stremio_ip_replacement_cooldown_minutes_snapshot := COALESCE(NEW.stremio_ip_replacement_cooldown_minutes_snapshot,p.stremio_ip_replacement_cooldown_minutes);
      ELSE
        NEW.stremio_household_network_limit_snapshot := p.stremio_household_network_limit;
        NEW.stremio_ip_replacement_policy_snapshot := p.stremio_ip_replacement_policy;
        NEW.stremio_ip_replacement_cooldown_minutes_snapshot := p.stremio_ip_replacement_cooldown_minutes;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_stremio_household_policy_snapshot ON subscriptions;
CREATE TRIGGER subscriptions_stremio_household_policy_snapshot
BEFORE INSERT OR UPDATE OF plan_id ON subscriptions
FOR EACH ROW EXECUTE FUNCTION snapshot_subscription_stremio_household_policy();

COMMIT;
