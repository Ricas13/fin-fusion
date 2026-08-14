BEGIN;

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS request_movie_quota_limit INTEGER,
    ADD COLUMN IF NOT EXISTS request_movie_quota_days INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS request_tv_quota_limit INTEGER,
    ADD COLUMN IF NOT EXISTS request_tv_quota_days INTEGER NOT NULL DEFAULT 30;

ALTER TABLE plans
    DROP CONSTRAINT IF EXISTS plans_request_movie_quota_limit_check,
    DROP CONSTRAINT IF EXISTS plans_request_movie_quota_days_check,
    DROP CONSTRAINT IF EXISTS plans_request_tv_quota_limit_check,
    DROP CONSTRAINT IF EXISTS plans_request_tv_quota_days_check;

ALTER TABLE plans
    ADD CONSTRAINT plans_request_movie_quota_limit_check CHECK (request_movie_quota_limit IS NULL OR request_movie_quota_limit BETWEEN 1 AND 10000),
    ADD CONSTRAINT plans_request_movie_quota_days_check CHECK (request_movie_quota_days BETWEEN 1 AND 3650),
    ADD CONSTRAINT plans_request_tv_quota_limit_check CHECK (request_tv_quota_limit IS NULL OR request_tv_quota_limit BETWEEN 1 AND 10000),
    ADD CONSTRAINT plans_request_tv_quota_days_check CHECK (request_tv_quota_days BETWEEN 1 AND 3650);

ALTER TABLE request_user_sync
    ADD COLUMN IF NOT EXISTS active_permissions INTEGER,
    ADD COLUMN IF NOT EXISTS access_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS applied_plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS applied_movie_quota_limit INTEGER,
    ADD COLUMN IF NOT EXISTS applied_movie_quota_days INTEGER,
    ADD COLUMN IF NOT EXISTS applied_tv_quota_limit INTEGER,
    ADD COLUMN IF NOT EXISTS applied_tv_quota_days INTEGER;

CREATE INDEX IF NOT EXISTS request_user_sync_access_idx
    ON request_user_sync(access_suspended,status);

COMMIT;
