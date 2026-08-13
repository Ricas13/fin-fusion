BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','reseller','customer')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    totp_secret_encrypted TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS resellers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
    credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
    trial_credits INTEGER NOT NULL DEFAULT 0 CHECK (trial_credits >= 0 AND trial_credits <= 20),
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jellyfin_servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    server_class TEXT NOT NULL CHECK (server_class IN ('premium','free','custom')),
    base_url TEXT NOT NULL,
    public_url TEXT,
    api_key_encrypted TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    priority INTEGER NOT NULL DEFAULT 100,
    max_users INTEGER,
    health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown','healthy','degraded','offline')),
    last_health_check TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'direct' CHECK (audience IN ('direct','reseller','both')),
    billing_interval TEXT NOT NULL CHECK (billing_interval IN ('trial','month','6_months','year','custom')),
    duration_days INTEGER,
    price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    streams INTEGER NOT NULL DEFAULT 1 CHECK (streams > 0),
    allow_downloads BOOLEAN NOT NULL DEFAULT FALSE,
    allow_video_transcoding BOOLEAN NOT NULL DEFAULT FALSE,
    allow_audio_transcoding BOOLEAN NOT NULL DEFAULT TRUE,
    allow_live_tv BOOLEAN NOT NULL DEFAULT TRUE,
    allow_live_tv_management BOOLEAN NOT NULL DEFAULT FALSE,
    server_class TEXT NOT NULL DEFAULT 'premium' CHECK (server_class IN ('premium','free','custom')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    reseller_id UUID REFERENCES resellers(id) ON DELETE SET NULL,
    display_name TEXT,
    email TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jellyfin_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE RESTRICT,
    jellyfin_user_id TEXT NOT NULL,
    jellyfin_username TEXT NOT NULL,
    disabled BOOLEAN NOT NULL DEFAULT FALSE,
    last_activity_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(server_id, jellyfin_user_id),
    UNIQUE(server_id, jellyfin_username)
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','paused','cancelled','expired')),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','reseller_credit','stripe','paypal','migration')),
    starts_at TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    provider_customer_id TEXT,
    provider_subscription_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions(status);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_unique
    ON subscriptions(source, provider_subscription_id)
    WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal','manual')),
    provider_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    processed_at TIMESTAMPTZ,
    processing_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reseller_id UUID NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('add','deduct','refund','adjustment')),
    note TEXT NOT NULL DEFAULT '',
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    reseller_id UUID REFERENCES resellers(id) ON DELETE SET NULL,
    media_type TEXT CHECK (media_type IN ('movie','series','other')),
    title TEXT,
    external_id TEXT,
    request_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','searching','available','failed')),
    admin_response TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO plans (code,name,audience,billing_interval,duration_days,price_minor,currency,streams,allow_downloads,allow_video_transcoding,server_class)
VALUES
    ('trial-24h','24-hour Trial','both','trial',1,0,'USD',1,FALSE,FALSE,'premium'),
    ('monthly','Monthly','both','month',30,600,'USD',3,TRUE,FALSE,'premium'),
    ('six-month','6 Months','both','6_months',183,3000,'USD',3,TRUE,FALSE,'premium'),
    ('yearly','Yearly','both','year',365,5000,'USD',3,TRUE,FALSE,'premium')
ON CONFLICT (code) DO NOTHING;

COMMIT;
