BEGIN;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_protected BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_protected_reason TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_protected_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS automation_protected_by UUID REFERENCES app_users(id) ON DELETE SET NULL;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS marketing_features TEXT[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_marketing_features_max_four;
ALTER TABLE plans ADD CONSTRAINT plans_marketing_features_max_four CHECK (COALESCE(cardinality(marketing_features),0) <= 4);
COMMIT;
