-- Free Server inactivity thresholds are operational properties of the server
-- that owns the Free-lane Jellyfin account. Keep the historical 3 / 7 / 30
-- behaviour as defaults so existing Free servers do not change behaviour when
-- this migration is applied.
ALTER TABLE jellyfin_servers
    ADD COLUMN IF NOT EXISTS free_first_playback_grace_days integer,
    ADD COLUMN IF NOT EXISTS free_playback_window_days integer,
    ADD COLUMN IF NOT EXISTS free_minimum_playback_minutes integer;

UPDATE jellyfin_servers
SET free_first_playback_grace_days = COALESCE(free_first_playback_grace_days, 3),
    free_playback_window_days = COALESCE(free_playback_window_days, 7),
    free_minimum_playback_minutes = COALESCE(free_minimum_playback_minutes, 30)
WHERE free_first_playback_grace_days IS NULL
   OR free_playback_window_days IS NULL
   OR free_minimum_playback_minutes IS NULL;

ALTER TABLE jellyfin_servers
    ALTER COLUMN free_first_playback_grace_days SET DEFAULT 3,
    ALTER COLUMN free_first_playback_grace_days SET NOT NULL,
    ALTER COLUMN free_playback_window_days SET DEFAULT 7,
    ALTER COLUMN free_playback_window_days SET NOT NULL,
    ALTER COLUMN free_minimum_playback_minutes SET DEFAULT 30,
    ALTER COLUMN free_minimum_playback_minutes SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'jellyfin_servers_free_first_playback_grace_days_check'
          AND conrelid = 'jellyfin_servers'::regclass
    ) THEN
        ALTER TABLE jellyfin_servers
            ADD CONSTRAINT jellyfin_servers_free_first_playback_grace_days_check
            CHECK (free_first_playback_grace_days BETWEEN 1 AND 3650);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'jellyfin_servers_free_playback_window_days_check'
          AND conrelid = 'jellyfin_servers'::regclass
    ) THEN
        ALTER TABLE jellyfin_servers
            ADD CONSTRAINT jellyfin_servers_free_playback_window_days_check
            CHECK (free_playback_window_days BETWEEN 1 AND 365);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'jellyfin_servers_free_minimum_playback_minutes_check'
          AND conrelid = 'jellyfin_servers'::regclass
    ) THEN
        ALTER TABLE jellyfin_servers
            ADD CONSTRAINT jellyfin_servers_free_minimum_playback_minutes_check
            CHECK (free_minimum_playback_minutes BETWEEN 1 AND 1000000);
    END IF;
END
$$;
