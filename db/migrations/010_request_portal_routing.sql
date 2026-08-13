BEGIN;

CREATE TABLE IF NOT EXISTS arr_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('radarr','sonarr')),
    base_url TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown','healthy','degraded','offline')),
    version TEXT,
    last_health_check TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS request_quality_tiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS request_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quality_tier_id UUID NOT NULL REFERENCES request_quality_tiers(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL CHECK (media_type IN ('movie','series')),
    arr_instance_id UUID NOT NULL REFERENCES arr_instances(id) ON DELETE RESTRICT,
    quality_profile_id INTEGER NOT NULL CHECK (quality_profile_id > 0),
    quality_profile_name TEXT NOT NULL,
    root_folder_path TEXT NOT NULL,
    monitor_mode TEXT NOT NULL DEFAULT 'all',
    search_on_add BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(quality_tier_id, media_type)
);

ALTER TABLE content_requests
    ADD COLUMN IF NOT EXISTS tmdb_id INTEGER,
    ADD COLUMN IF NOT EXISTS tvdb_id INTEGER,
    ADD COLUMN IF NOT EXISTS year INTEGER,
    ADD COLUMN IF NOT EXISTS poster_path TEXT,
    ADD COLUMN IF NOT EXISTS backdrop_path TEXT,
    ADD COLUMN IF NOT EXISTS quality_tier_id UUID REFERENCES request_quality_tiers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS arr_instance_id UUID REFERENCES arr_instances(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS arr_item_id INTEGER,
    ADD COLUMN IF NOT EXISTS routed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_status_check TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE content_requests DROP CONSTRAINT IF EXISTS content_requests_status_check;
ALTER TABLE content_requests ADD CONSTRAINT content_requests_status_check
    CHECK (status IN ('pending','approved','added','declined','searching','available','failed'));

CREATE INDEX IF NOT EXISTS content_requests_tmdb_idx
    ON content_requests(media_type, tmdb_id);
CREATE INDEX IF NOT EXISTS content_requests_arr_tracking_idx
    ON content_requests(arr_instance_id, arr_item_id)
    WHERE arr_instance_id IS NOT NULL AND arr_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_requests_customer_created_idx
    ON content_requests(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS request_routes_instance_idx ON request_routes(arr_instance_id);

INSERT INTO request_quality_tiers(code,name,description,sort_order)
VALUES
    ('1080p','1080p','Standard Full HD request',10),
    ('4k','4K','Ultra HD / 4K request',20)
ON CONFLICT (code) DO NOTHING;

COMMIT;
