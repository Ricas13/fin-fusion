BEGIN;

-- Stremio is introduced as a delivery type without changing the behaviour of
-- existing catalogue plans. Every existing plan remains a Jellyfin plan until
-- an explicit future workflow changes it.
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS service_type TEXT NOT NULL DEFAULT 'jellyfin';
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_service_type_check;
ALTER TABLE plans
    ADD CONSTRAINT plans_service_type_check
    CHECK (service_type IN ('jellyfin','stremio','bundle'));

-- A server must be explicitly opted in before a future Stremio placement
-- workflow can use it. Existing Jellyfin placement remains unchanged.
ALTER TABLE jellyfin_servers
    ADD COLUMN IF NOT EXISTS stremio_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve delivery type with the subscription contract, just like price,
-- currency and plan name. This prevents a later catalogue edit from silently
-- converting an already-created subscription between Jellyfin/Stremio/bundle.
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS service_type_snapshot TEXT;
UPDATE subscriptions s
SET service_type_snapshot=p.service_type
FROM plans p
WHERE p.id=s.plan_id AND s.service_type_snapshot IS NULL;
ALTER TABLE subscriptions
    ALTER COLUMN service_type_snapshot SET NOT NULL;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_service_type_snapshot_check;
ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_service_type_snapshot_check
    CHECK (service_type_snapshot IN ('jellyfin','stremio','bundle'));

CREATE TABLE IF NOT EXISTS stremio_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL UNIQUE REFERENCES subscriptions(id) ON DELETE CASCADE,
    server_id UUID REFERENCES jellyfin_servers(id) ON DELETE SET NULL,
    jellyfin_account_id UUID REFERENCES jellyfin_accounts(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','active','suspended','revoked')),
    stream_limit INTEGER NOT NULL CHECK (stream_limit BETWEEN 1 AND 50),
    token_hash TEXT,
    token_hint TEXT,
    token_version INTEGER NOT NULL DEFAULT 1 CHECK (token_version > 0),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT stremio_entitlement_token_hash_format
        CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS stremio_entitlements_token_hash_unique
    ON stremio_entitlements(token_hash)
    WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS stremio_entitlements_customer_idx
    ON stremio_entitlements(customer_id, status);
CREATE INDEX IF NOT EXISTS stremio_entitlements_server_idx
    ON stremio_entitlements(server_id, status)
    WHERE server_id IS NOT NULL;

-- Protect the future runtime from cross-account entitlement wiring. The
-- subscription is the commercial owner; any assigned Jellyfin account must
-- belong to the same customer and server. Active delivery must also have a
-- server, restricted Jellyfin identity and install credential already assigned.
CREATE OR REPLACE FUNCTION enforce_stremio_entitlement_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    subscription_customer UUID;
    subscription_service TEXT;
    account_customer UUID;
    account_server UUID;
    server_allowed BOOLEAN;
BEGIN
    SELECT customer_id, service_type_snapshot
      INTO subscription_customer, subscription_service
      FROM subscriptions
     WHERE id=NEW.subscription_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Stremio entitlement subscription not found';
    END IF;
    IF subscription_customer IS DISTINCT FROM NEW.customer_id THEN
        RAISE EXCEPTION 'Stremio entitlement customer does not own subscription';
    END IF;
    IF subscription_service NOT IN ('stremio','bundle') THEN
        RAISE EXCEPTION 'Subscription does not include Stremio delivery';
    END IF;

    IF NEW.server_id IS NOT NULL AND NEW.status <> 'revoked' THEN
        SELECT stremio_enabled INTO server_allowed
          FROM jellyfin_servers
         WHERE id=NEW.server_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Stremio entitlement server not found';
        END IF;
        IF server_allowed IS NOT TRUE THEN
            RAISE EXCEPTION 'Jellyfin server is not eligible for Stremio delivery';
        END IF;
    END IF;

    IF NEW.jellyfin_account_id IS NOT NULL THEN
        SELECT customer_id, server_id
          INTO account_customer, account_server
          FROM jellyfin_accounts
         WHERE id=NEW.jellyfin_account_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Stremio entitlement Jellyfin account not found';
        END IF;
        IF account_customer IS DISTINCT FROM NEW.customer_id THEN
            RAISE EXCEPTION 'Stremio Jellyfin account belongs to another customer';
        END IF;
        IF NEW.server_id IS NULL OR account_server IS DISTINCT FROM NEW.server_id THEN
            RAISE EXCEPTION 'Stremio Jellyfin account does not belong to assigned server';
        END IF;
    END IF;

    IF NEW.status='active' AND
       (NEW.server_id IS NULL OR NEW.jellyfin_account_id IS NULL OR NEW.token_hash IS NULL) THEN
        RAISE EXCEPTION 'Active Stremio entitlement requires server, Jellyfin account and install credential';
    END IF;

    IF NEW.status='revoked' THEN
        NEW.revoked_at := COALESCE(NEW.revoked_at,NOW());
    ELSIF NEW.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'Only revoked Stremio entitlements may have revoked_at set';
    END IF;

    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS stremio_entitlements_integrity ON stremio_entitlements;
CREATE TRIGGER stremio_entitlements_integrity
BEFORE INSERT OR UPDATE ON stremio_entitlements
FOR EACH ROW EXECUTE FUNCTION enforce_stremio_entitlement_integrity();

-- Extend the subscription snapshot trigger introduced by the lifecycle
-- integrity migrations. Explicitly supplied snapshots still win; otherwise the
-- current plan value is copied when the subscription is created or plan_id is
-- deliberately changed by the canonical lifecycle owner.
CREATE OR REPLACE FUNCTION snapshot_subscription_plan_terms()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p plans%ROWTYPE;
BEGIN
    IF TG_OP='INSERT' THEN
        SELECT * INTO p FROM plans WHERE id=NEW.plan_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
        NEW.plan_name_snapshot := COALESCE(NEW.plan_name_snapshot,p.name);
        NEW.plan_code_snapshot := COALESCE(NEW.plan_code_snapshot,p.code);
        NEW.price_minor_snapshot := COALESCE(NEW.price_minor_snapshot,p.price_minor);
        NEW.currency_snapshot := COALESCE(NEW.currency_snapshot,p.currency);
        NEW.billing_interval_snapshot := COALESCE(NEW.billing_interval_snapshot,p.billing_interval);
        NEW.duration_days_snapshot := COALESCE(NEW.duration_days_snapshot,p.duration_days);
        NEW.service_type_snapshot := COALESCE(NEW.service_type_snapshot,p.service_type);
    ELSIF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
        SELECT * INTO p FROM plans WHERE id=NEW.plan_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
        IF NEW.plan_name_snapshot IS NOT DISTINCT FROM OLD.plan_name_snapshot THEN NEW.plan_name_snapshot := p.name; END IF;
        IF NEW.plan_code_snapshot IS NOT DISTINCT FROM OLD.plan_code_snapshot THEN NEW.plan_code_snapshot := p.code; END IF;
        IF NEW.price_minor_snapshot IS NOT DISTINCT FROM OLD.price_minor_snapshot THEN NEW.price_minor_snapshot := p.price_minor; END IF;
        IF NEW.currency_snapshot IS NOT DISTINCT FROM OLD.currency_snapshot THEN NEW.currency_snapshot := p.currency; END IF;
        IF NEW.billing_interval_snapshot IS NOT DISTINCT FROM OLD.billing_interval_snapshot THEN NEW.billing_interval_snapshot := p.billing_interval; END IF;
        IF NEW.duration_days_snapshot IS NOT DISTINCT FROM OLD.duration_days_snapshot THEN NEW.duration_days_snapshot := p.duration_days; END IF;
        IF NEW.service_type_snapshot IS NOT DISTINCT FROM OLD.service_type_snapshot THEN NEW.service_type_snapshot := p.service_type; END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON COLUMN plans.service_type IS 'Delivery surface: jellyfin, stremio, or bundle. Foundation only until Stremio runtime is enabled.';
COMMENT ON COLUMN jellyfin_servers.stremio_enabled IS 'Explicit opt-in for future Stremio placement. Does not change normal Jellyfin placement.';
COMMENT ON TABLE stremio_entitlements IS 'Control-plane state for user-specific Stremio addon access. Raw install tokens are never stored.';

COMMIT;
