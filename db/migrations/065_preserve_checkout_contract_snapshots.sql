BEGIN;

-- Migration 047 introduced plan-term snapshots, but its trigger always replaced
-- explicitly supplied values with the CURRENT catalogue row on INSERT. That
-- breaks the immutable checkout contract when a plan changes while the customer
-- is on a hosted provider checkout. Preserve values supplied by the lifecycle
-- owner; only fill fields that are missing. On an actual plan_id change, refresh
-- unchanged legacy snapshots from the new plan while still respecting any
-- explicit snapshot values supplied by the same UPDATE.
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
    ELSIF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
        SELECT * INTO p FROM plans WHERE id=NEW.plan_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
        IF NEW.plan_name_snapshot IS NOT DISTINCT FROM OLD.plan_name_snapshot THEN NEW.plan_name_snapshot := p.name; END IF;
        IF NEW.plan_code_snapshot IS NOT DISTINCT FROM OLD.plan_code_snapshot THEN NEW.plan_code_snapshot := p.code; END IF;
        IF NEW.price_minor_snapshot IS NOT DISTINCT FROM OLD.price_minor_snapshot THEN NEW.price_minor_snapshot := p.price_minor; END IF;
        IF NEW.currency_snapshot IS NOT DISTINCT FROM OLD.currency_snapshot THEN NEW.currency_snapshot := p.currency; END IF;
        IF NEW.billing_interval_snapshot IS NOT DISTINCT FROM OLD.billing_interval_snapshot THEN NEW.billing_interval_snapshot := p.billing_interval; END IF;
        IF NEW.duration_days_snapshot IS NOT DISTINCT FROM OLD.duration_days_snapshot THEN NEW.duration_days_snapshot := p.duration_days; END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
