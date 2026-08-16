BEGIN;

-- Operator-facing commercial controls. These columns are deliberately additive
-- so existing products keep their historical semantics until an administrator
-- opts into the new controls.
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS capacity_limit INTEGER,
    ADD COLUMN IF NOT EXISTS is_addon BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS inactivity_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_capacity_limit_check;
ALTER TABLE plans ADD CONSTRAINT plans_capacity_limit_check
    CHECK (capacity_limit IS NULL OR capacity_limit > 0);

CREATE INDEX IF NOT EXISTS subscriptions_plan_status_idx
    ON subscriptions(plan_id,status,current_period_end DESC);

-- Portal identity is independent from service entitlement. A ban can block
-- future registration and/or service access without deleting the portal record.
CREATE TABLE IF NOT EXISTS customer_bans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    normalized_email TEXT,
    reason TEXT NOT NULL DEFAULT '',
    blocks_registration BOOLEAN NOT NULL DEFAULT TRUE,
    blocks_service_access BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    CHECK (normalized_email IS NULL OR normalized_email = LOWER(BTRIM(normalized_email)))
);
CREATE INDEX IF NOT EXISTS customer_bans_customer_active_idx
    ON customer_bans(customer_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_bans_email_active_idx
    ON customer_bans(normalized_email) WHERE revoked_at IS NULL AND normalized_email IS NOT NULL;

-- Optional communication channels. Email remains canonical on app_users/customers;
-- these fields only describe opt-in secondary delivery channels.
CREATE TABLE IF NOT EXISTS customer_communication_preferences (
    customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    phone_e164 TEXT,
    whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    telegram_handle TEXT,
    telegram_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    discord_handle TEXT,
    discord_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Verified registration may be staged for up to an hour. Preserve optional
-- contact choices in the staged record without creating a customer early.
ALTER TABLE pending_registrations
    ADD COLUMN IF NOT EXISTS communication_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Per-administrator read cursors power lightweight unread badges without
-- coupling the navigation shell to every source table.
CREATE TABLE IF NOT EXISTS admin_nav_read_state (
    admin_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    nav_key TEXT NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(admin_user_id,nav_key)
);

ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS discord_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Migration 047 extended the original email-only outbox to Telegram/webhook.
-- Keep one durable queue and explicitly admit the two first-class channels used
-- by the operator notification matrix.
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_channel_check;
ALTER TABLE notification_outbox
    ADD CONSTRAINT notification_outbox_channel_check
    CHECK (channel IN ('email','telegram','webhook','discord','whatsapp'));

INSERT INTO platform_settings(setting_key,setting_value)
VALUES
('reporting_currency_v1', jsonb_build_object(
    'currency','GBP',
    'rates',jsonb_build_object('GBP',1.0,'USD',1.27,'EUR',1.17),
    'updatedAt',NOW()
)),
('customer_inactivity_policy_v1', jsonb_build_object(
    'enabled',false,
    'planCodes',jsonb_build_array('trial-24h'),
    'inactiveDays',7,
    'minimumPlaybackMinutes',0,
    'action','disable_jellyfin',
    'dryRun',true,
    'minimumObservationHours',24
)),
('notification_channels_v1', jsonb_build_object(
    'discord',jsonb_build_object('enabled',false,'webhookUrl',''),
    'whatsapp',jsonb_build_object('enabled',false,'graphApiVersion','v23.0','phoneNumberId',''),
    'adminEmail',''
))
ON CONFLICT(setting_key) DO NOTHING;

INSERT INTO notification_preferences(event_type) VALUES
 ('customer.registered'),
 ('customer.trial.requested'),
 ('customer.subscription.requested'),
 ('customer.stremio.requested'),
 ('customer.reseller.requested'),
 ('customer.service.provisioned'),
 ('customer.service.expired'),
 ('customer.service.inactive'),
 ('server.offline'),
 ('attention.created')
ON CONFLICT(event_type) DO NOTHING;

COMMIT;
