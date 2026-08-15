BEGIN;

-- A catalogue plan describes what may be sold now. A subscription describes
-- what a customer already bought. Snapshot commercial terms on the contract so
-- later catalogue edits/archival cannot rewrite billing history or reporting.
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS plan_name_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS plan_code_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS price_minor_snapshot INTEGER,
    ADD COLUMN IF NOT EXISTS currency_snapshot CHAR(3),
    ADD COLUMN IF NOT EXISTS billing_interval_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS duration_days_snapshot INTEGER,
    ADD COLUMN IF NOT EXISTS provider_price_id_snapshot TEXT;

UPDATE subscriptions s
SET plan_name_snapshot=COALESCE(s.plan_name_snapshot,p.name),
    plan_code_snapshot=COALESCE(s.plan_code_snapshot,p.code),
    price_minor_snapshot=COALESCE(s.price_minor_snapshot,p.price_minor),
    currency_snapshot=COALESCE(s.currency_snapshot,p.currency),
    billing_interval_snapshot=COALESCE(s.billing_interval_snapshot,p.billing_interval),
    duration_days_snapshot=COALESCE(s.duration_days_snapshot,p.duration_days)
FROM plans p
WHERE p.id=s.plan_id;

CREATE OR REPLACE FUNCTION snapshot_subscription_plan_terms()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p plans%ROWTYPE;
BEGIN
    IF TG_OP='INSERT' OR NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
        SELECT * INTO p FROM plans WHERE id=NEW.plan_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found'; END IF;
        NEW.plan_name_snapshot := p.name;
        NEW.plan_code_snapshot := p.code;
        NEW.price_minor_snapshot := p.price_minor;
        NEW.currency_snapshot := p.currency;
        NEW.billing_interval_snapshot := p.billing_interval;
        NEW.duration_days_snapshot := p.duration_days;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS snapshot_subscription_plan_terms_trigger ON subscriptions;
CREATE TRIGGER snapshot_subscription_plan_terms_trigger
BEFORE INSERT OR UPDATE OF plan_id ON subscriptions
FOR EACH ROW EXECUTE FUNCTION snapshot_subscription_plan_terms();

-- Archival is a catalogue lifecycle concern, not an entitlement revocation.
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES app_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS plans_archived_idx ON plans(archived_at) WHERE archived_at IS NOT NULL;

-- Separate "do not place new customers" from server availability. Existing
-- assignments stay valid while a server is draining/under maintenance.
ALTER TABLE jellyfin_servers
    ADD COLUMN IF NOT EXISTS placement_mode TEXT NOT NULL DEFAULT 'active';
ALTER TABLE jellyfin_servers DROP CONSTRAINT IF EXISTS jellyfin_servers_placement_mode_check;
ALTER TABLE jellyfin_servers
    ADD CONSTRAINT jellyfin_servers_placement_mode_check
    CHECK (placement_mode IN ('active','drain','maintenance'));

-- Cross-process worker liveness. Each worker periodically upserts its own row;
-- readiness/configuration pages can distinguish configured jobs from a dead
-- worker process.
CREATE TABLE IF NOT EXISTS operational_worker_state (
    worker_key TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    version TEXT,
    commit_sha TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    draining_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS operational_worker_heartbeat_idx
    ON operational_worker_state(last_heartbeat_at DESC);

-- A manual "Run now" is a one-shot force request. This lets an administrator
-- intentionally execute a disabled job without silently enabling its schedule.
ALTER TABLE automation_job_state
    ADD COLUMN IF NOT EXISTS force_run_requested BOOLEAN NOT NULL DEFAULT FALSE;

-- Durable multi-channel notification delivery. Email keeps its specialised
-- outbox, while non-email channels use this queue so provider/network failures
-- are retryable and observable instead of disappearing synchronously.
CREATE TABLE IF NOT EXISTS notification_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel TEXT NOT NULL CHECK (channel IN ('telegram','webhook')),
    event_type TEXT NOT NULL,
    destination TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','dead','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    last_error TEXT,
    dedupe_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedupe_unique
    ON notification_outbox(channel,dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_outbox_due_idx
    ON notification_outbox(state,next_attempt_at) WHERE state='pending';

-- Operational incidents need workflow state, not only detection.
ALTER TABLE payment_incidents
    ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS acknowledged_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES app_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS resolution_note TEXT;

CREATE TABLE IF NOT EXISTS payment_incident_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id UUID NOT NULL REFERENCES payment_incidents(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payment_incident_notes_incident_idx
    ON payment_incident_notes(incident_id,created_at DESC);

-- One persisted operational settings object replaces process-local assumptions
-- for public URL, locale, session policy and placement behavior.
INSERT INTO platform_settings(setting_key,setting_value)
VALUES ('operations_v1', jsonb_build_object(
    'publicBaseUrl','',
    'locale','en-GB',
    'timezone','Europe/London',
    'placementHealthMode','healthy_or_degraded',
    'customerSessionHours',168,
    'staffSessionHours',12,
    'registrationRateLimitPerHour',20,
    'notificationCooldownMinutes',30
)) ON CONFLICT(setting_key) DO NOTHING;

COMMIT;
