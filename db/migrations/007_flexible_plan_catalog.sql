BEGIN;

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS reseller_credit_cost INTEGER,
    ADD COLUMN IF NOT EXISTS reseller_trial_credit_cost INTEGER;

ALTER TABLE plans
    DROP CONSTRAINT IF EXISTS plans_reseller_credit_cost_check,
    DROP CONSTRAINT IF EXISTS plans_reseller_trial_credit_cost_check;

ALTER TABLE plans
    ADD CONSTRAINT plans_reseller_credit_cost_check
        CHECK (reseller_credit_cost IS NULL OR reseller_credit_cost >= 0),
    ADD CONSTRAINT plans_reseller_trial_credit_cost_check
        CHECK (reseller_trial_credit_cost IS NULL OR reseller_trial_credit_cost >= 0);

-- Preserve the historical one-credit reseller behaviour for the seeded plans.
UPDATE plans
SET reseller_credit_cost = COALESCE(reseller_credit_cost, 1)
WHERE audience IN ('reseller','both');

-- The seeded trial can consume a trial credit as well.
UPDATE plans
SET reseller_trial_credit_cost = COALESCE(reseller_trial_credit_cost, 1)
WHERE code = 'trial-24h' AND audience IN ('reseller','both');

COMMIT;
