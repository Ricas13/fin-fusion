BEGIN;

-- Presentation/reporting currency is a user preference. NULL means follow the
-- platform default in reporting_currency_v1. Transaction/provider currency is
-- never rewritten by this preference.
ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS preferred_currency CHAR(3);
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_preferred_currency_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_preferred_currency_check
    CHECK (preferred_currency IS NULL OR preferred_currency IN ('GBP','USD','EUR'));

-- One logical plan may expose several sellable prices. Keep plans.price_minor /
-- plans.currency as the compatibility/default price while callers migrate to
-- this table. Historical subscriptions continue using their immutable snapshot.
CREATE TABLE IF NOT EXISTS plan_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    currency CHAR(3) NOT NULL CHECK (currency IN ('GBP','USD','EUR')),
    price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(plan_id,currency)
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_prices_one_default_idx
    ON plan_prices(plan_id) WHERE is_default=TRUE;
CREATE INDEX IF NOT EXISTS plan_prices_sellable_idx
    ON plan_prices(plan_id,currency) WHERE active=TRUE;

INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default)
SELECT p.id,
       CASE WHEN p.currency IN ('GBP','USD','EUR') THEN p.currency ELSE 'GBP' END,
       p.price_minor,
       TRUE,
       TRUE
FROM plans p
ON CONFLICT(plan_id,currency) DO NOTHING;

-- Provider mappings belong to a concrete currency price, not merely the
-- logical access plan. Backfill existing mappings to the plan's default price.
ALTER TABLE plan_provider_prices
    ADD COLUMN IF NOT EXISTS plan_price_id UUID REFERENCES plan_prices(id) ON DELETE CASCADE;
UPDATE plan_provider_prices pp
SET plan_price_id=pr.id
FROM plan_prices pr
WHERE pr.plan_id=pp.plan_id
  AND pr.is_default=TRUE
  AND pp.plan_price_id IS NULL;
ALTER TABLE plan_provider_prices ALTER COLUMN plan_price_id SET NOT NULL;
ALTER TABLE plan_provider_prices DROP CONSTRAINT IF EXISTS plan_provider_prices_plan_id_provider_key;
ALTER TABLE plan_provider_prices DROP CONSTRAINT IF EXISTS plan_provider_prices_plan_id_provider_checkout_mode_key;
DROP INDEX IF EXISTS plan_provider_prices_plan_id_provider_key;
DROP INDEX IF EXISTS plan_provider_prices_plan_id_provider_checkout_mode_key;
CREATE UNIQUE INDEX IF NOT EXISTS plan_provider_prices_price_provider_mode_unique
    ON plan_provider_prices(plan_price_id,provider,checkout_mode);
CREATE INDEX IF NOT EXISTS plan_provider_prices_plan_currency_idx
    ON plan_provider_prices(plan_id,plan_price_id,provider,active);

ALTER TABLE billing_checkout_intents
    ADD COLUMN IF NOT EXISTS plan_price_id UUID REFERENCES plan_prices(id) ON DELETE SET NULL;
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS plan_price_id_snapshot UUID,
    ADD COLUMN IF NOT EXISTS provider_mapping_id_snapshot UUID,
    ADD COLUMN IF NOT EXISTS provider_mapping_external_id_snapshot TEXT;

-- The global catalogue now describes audience/permission separately from each
-- administrator/customer recipient's personal routing choices.
ALTER TABLE notification_preferences
    ADD COLUMN IF NOT EXISTS event_scope TEXT NOT NULL DEFAULT 'admin',
    ADD COLUMN IF NOT EXISTS customer_opt_in_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_event_scope_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_event_scope_check
    CHECK (event_scope IN ('admin','customer','both'));

CREATE TABLE IF NOT EXISTS admin_notification_preferences (
    admin_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('email','telegram','discord','whatsapp')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(admin_user_id,event_type,channel)
);
CREATE INDEX IF NOT EXISTS admin_notification_preferences_event_idx
    ON admin_notification_preferences(event_type,channel) WHERE enabled=TRUE;

CREATE TABLE IF NOT EXISTS admin_communication_preferences (
    admin_user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    telegram_chat_id TEXT,
    telegram_handle TEXT,
    telegram_linked_at TIMESTAMPTZ,
    discord_user_id TEXT,
    discord_handle TEXT,
    discord_linked_at TIMESTAMPTZ,
    phone_e164 TEXT,
    whatsapp_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    whatsapp_opted_in_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_comm_telegram_chat_unique
    ON admin_communication_preferences(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS admin_comm_discord_user_unique
    ON admin_communication_preferences(discord_user_id) WHERE discord_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_channel_link_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK(channel IN ('telegram','discord')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_channel_link_tokens_lookup_idx
    ON admin_channel_link_tokens(channel,token_hash,expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_notification_preferences (
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('telegram','discord','whatsapp')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(customer_id,event_type,channel)
);
CREATE INDEX IF NOT EXISTS customer_notification_preferences_event_idx
    ON customer_notification_preferences(event_type,channel) WHERE enabled=TRUE;

-- Canonical event catalogue. Customer-safe events are explicitly marked; all
-- infrastructure, reseller and operator events remain admin-only by default.
INSERT INTO notification_preferences(event_type,event_scope,customer_opt_in_allowed,display_name,description)
VALUES
 ('customer.registered','admin',FALSE,'New customer registration','A new customer account was created.'),
 ('payment.received','both',TRUE,'Payment received','A customer payment was confirmed by the provider.'),
 ('payment.failed','both',TRUE,'Payment failed','A customer payment or renewal failed.'),
 ('subscription.activated','both',TRUE,'Subscription activated','A customer subscription became active.'),
 ('subscription.cancelled','both',TRUE,'Subscription cancelled','A customer subscription was cancelled.'),
 ('subscription.expiring','both',TRUE,'Subscription expiring','A customer subscription is approaching expiry or renewal.'),
 ('customer.service.provisioned','both',TRUE,'Service provisioned','Customer service provisioning completed.'),
 ('account.announcement','customer',TRUE,'Important account/service announcements','Important account or service information.'),
 ('reseller.subscription.activated','admin',FALSE,'New reseller subscription','A reseller subscription became active.'),
 ('reseller.subscription.cancelled','admin',FALSE,'Reseller subscription cancelled','A reseller subscription was cancelled.'),
 ('reseller.payment.failed','admin',FALSE,'Reseller payment failed','A reseller payment or renewal failed.'),
 ('provisioning.failed','admin',FALSE,'Provisioning failure','Customer service provisioning failed.'),
 ('server.offline','admin',FALSE,'Jellyfin server offline','A managed Jellyfin server is offline.'),
 ('automation.error','admin',FALSE,'Automation/service error','A background automation or service failed.'),
 ('security.alert','admin',FALSE,'Security event','An operational security event needs attention.')
ON CONFLICT(event_type) DO UPDATE SET
 event_scope=EXCLUDED.event_scope,
 customer_opt_in_allowed=EXCLUDED.customer_opt_in_allowed,
 display_name=COALESCE(notification_preferences.display_name,EXCLUDED.display_name),
 description=COALESCE(notification_preferences.description,EXCLUDED.description);

-- Existing legacy global routing becomes the starting preference of current
-- admins, avoiding a surprise notification outage after migration. Future
-- administrators start with everything off and opt in themselves.
INSERT INTO admin_notification_preferences(admin_user_id,event_type,channel,enabled)
SELECT u.id,n.event_type,v.channel,TRUE
FROM app_users u
JOIN notification_preferences n ON n.event_scope IN ('admin','both')
CROSS JOIN LATERAL (VALUES
 ('email',n.email_enabled),('telegram',n.telegram_enabled),('discord',n.discord_enabled),('whatsapp',n.whatsapp_enabled)
) v(channel,enabled)
WHERE u.role='admin' AND u.active=TRUE AND v.enabled=TRUE
ON CONFLICT(admin_user_id,event_type,channel) DO NOTHING;

-- Preserve existing customer channel-level choices by initially enabling their
-- currently opted-in channels for every customer-safe event. The customer UI
-- can then narrow this matrix event-by-event.
INSERT INTO customer_notification_preferences(customer_id,event_type,channel,enabled)
SELECT cp.customer_id,n.event_type,v.channel,TRUE
FROM customer_communication_preferences cp
JOIN notification_preferences n ON n.customer_opt_in_allowed=TRUE AND n.event_scope IN ('customer','both')
CROSS JOIN LATERAL (VALUES
 ('telegram',cp.telegram_opt_in AND cp.telegram_chat_id IS NOT NULL),
 ('discord',cp.discord_opt_in AND cp.discord_user_id IS NOT NULL),
 ('whatsapp',cp.whatsapp_opt_in AND cp.phone_e164 IS NOT NULL)
) v(channel,enabled)
WHERE v.enabled=TRUE
ON CONFLICT(customer_id,event_type,channel) DO NOTHING;

COMMIT;
