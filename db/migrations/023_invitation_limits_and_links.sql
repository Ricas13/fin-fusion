BEGIN;

ALTER TABLE customer_invitations
    ADD COLUMN IF NOT EXISTS name TEXT,
    ADD COLUMN IF NOT EXISTS max_uses INTEGER,
    ADD COLUMN IF NOT EXISTS token_encrypted TEXT;

UPDATE customer_invitations i
SET name = COALESCE(NULLIF(BTRIM(i.name), ''), p.name || ' invitation')
FROM plans p
WHERE p.id = i.plan_id
  AND (i.name IS NULL OR BTRIM(i.name) = '');

UPDATE customer_invitations
SET max_uses = CASE WHEN single_use THEN 1 ELSE NULL END
WHERE max_uses IS NULL AND single_use = TRUE;

ALTER TABLE customer_invitations
    ALTER COLUMN name SET DEFAULT 'Invitation';

UPDATE customer_invitations
SET name = 'Invitation'
WHERE name IS NULL OR BTRIM(name) = '';

ALTER TABLE customer_invitations
    ALTER COLUMN name SET NOT NULL;

ALTER TABLE customer_invitations
    DROP CONSTRAINT IF EXISTS customer_invitations_name_length_check,
    DROP CONSTRAINT IF EXISTS customer_invitations_max_uses_check;

ALTER TABLE customer_invitations
    ADD CONSTRAINT customer_invitations_name_length_check
        CHECK (length(name) BETWEEN 1 AND 120),
    ADD CONSTRAINT customer_invitations_max_uses_check
        CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 10000);

ALTER TABLE invitation_redemptions
    ALTER COLUMN redeemed_email DROP NOT NULL;

COMMIT;
