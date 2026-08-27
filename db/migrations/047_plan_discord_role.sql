BEGIN;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS discord_role_id text;

COMMIT;
