BEGIN;

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS library_access_mode TEXT NOT NULL DEFAULT 'all'
        CHECK (library_access_mode IN ('all','exclude','include')),
    ADD COLUMN IF NOT EXISTS library_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE plans
SET library_names = ARRAY[]::TEXT[]
WHERE library_names IS NULL;

COMMIT;
