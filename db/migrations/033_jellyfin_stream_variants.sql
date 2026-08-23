-- Optional access-quantity price variants.
-- A logical CAPTAiNFiN plan remains one catalogue product. Paid Jellyfin plans
-- can vary simultaneous stream count; paid standalone Stremio plans can vary
-- household count. Each choice has its own local amount and provider mapping so
-- recurring contracts can be snapshotted/grandfathered without subscription
-- add-on quantities.

CREATE TABLE IF NOT EXISTS plan_access_variants (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  variant_kind text NOT NULL CHECK (variant_kind IN ('streams','households')),
  quantity integer NOT NULL CHECK (
    (variant_kind='streams' AND quantity BETWEEN 1 AND 50)
    OR (variant_kind='households' AND quantity BETWEEN 1 AND 10)
  ),
  currency character(3) NOT NULL,
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  active boolean NOT NULL DEFAULT TRUE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(plan_id, variant_kind, quantity, currency)
);

CREATE INDEX IF NOT EXISTS idx_plan_access_variants_plan_active
  ON plan_access_variants(plan_id, variant_kind, active, currency, quantity);

CREATE TABLE IF NOT EXISTS plan_access_variant_provider_prices (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  access_variant_id uuid NOT NULL REFERENCES plan_access_variants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe','paypal')),
  checkout_mode text NOT NULL CHECK (checkout_mode IN ('payment','subscription')),
  external_id text,
  active boolean NOT NULL DEFAULT TRUE,
  verified_at timestamp with time zone,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','drift','error','not_required')),
  verification_error text,
  remote_amount_minor integer,
  remote_currency character(3),
  remote_interval text,
  remote_active boolean,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(access_variant_id, provider, checkout_mode)
);

CREATE INDEX IF NOT EXISTS idx_access_variant_provider_lookup
  ON plan_access_variant_provider_prices(provider, external_id)
  WHERE active=TRUE AND external_id IS NOT NULL;

-- Migration 026 freezes Stremio household policy on the subscription. Extend its
-- trigger so a paid household commercial variant can deliberately override the
-- plan's base household count at purchase time while retaining the replacement
-- policy/cooldown snapshot behaviour.
CREATE OR REPLACE FUNCTION snapshot_subscription_stremio_household_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p plans%ROWTYPE;
  contract_limit INTEGER;
BEGIN
  IF NEW.commercial_snapshot IS NOT NULL
     AND jsonb_typeof(NEW.commercial_snapshot)='object'
     AND COALESCE(NEW.commercial_snapshot->>'stremioHouseholdNetworkLimit','') ~ '^[0-9]+$' THEN
    contract_limit := (NEW.commercial_snapshot->>'stremioHouseholdNetworkLimit')::INTEGER;
  END IF;

  IF TG_OP='INSERT' THEN
    SELECT * INTO p FROM plans WHERE id=NEW.plan_id;
    IF FOUND AND p.service_type IN ('stremio','bundle') THEN
      NEW.stremio_household_network_limit_snapshot := COALESCE(contract_limit,NEW.stremio_household_network_limit_snapshot,p.stremio_household_network_limit);
      NEW.stremio_ip_replacement_policy_snapshot := COALESCE(NEW.stremio_ip_replacement_policy_snapshot,p.stremio_ip_replacement_policy);
      NEW.stremio_ip_replacement_cooldown_minutes_snapshot := COALESCE(NEW.stremio_ip_replacement_cooldown_minutes_snapshot,p.stremio_ip_replacement_cooldown_minutes);
    END IF;
  ELSIF NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.commercial_snapshot IS DISTINCT FROM OLD.commercial_snapshot THEN
    SELECT * INTO p FROM plans WHERE id=NEW.plan_id;
    IF FOUND AND p.service_type IN ('stremio','bundle') THEN
      NEW.stremio_household_network_limit_snapshot := COALESCE(contract_limit,p.stremio_household_network_limit);
      NEW.stremio_ip_replacement_policy_snapshot := p.stremio_ip_replacement_policy;
      NEW.stremio_ip_replacement_cooldown_minutes_snapshot := p.stremio_ip_replacement_cooldown_minutes;
    ELSE
      NEW.stremio_household_network_limit_snapshot := NULL;
      NEW.stremio_ip_replacement_policy_snapshot := NULL;
      NEW.stremio_ip_replacement_cooldown_minutes_snapshot := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_stremio_household_policy_snapshot ON subscriptions;
CREATE TRIGGER subscriptions_stremio_household_policy_snapshot
BEFORE INSERT OR UPDATE OF plan_id,commercial_snapshot ON subscriptions
FOR EACH ROW EXECUTE FUNCTION snapshot_subscription_stremio_household_policy();
