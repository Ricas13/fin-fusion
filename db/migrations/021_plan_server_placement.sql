BEGIN;

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS placement_strategy TEXT NOT NULL DEFAULT 'balanced';

ALTER TABLE plans
    DROP CONSTRAINT IF EXISTS plans_placement_strategy_check;

ALTER TABLE plans
    ADD CONSTRAINT plans_placement_strategy_check
        CHECK (placement_strategy IN ('balanced','lowest_customers','lowest_streams','weighted','manual'));

CREATE TABLE IF NOT EXISTS plan_server_eligibility (
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    weight INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 10000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(plan_id, server_id)
);

CREATE INDEX IF NOT EXISTS plan_server_eligibility_server_idx
    ON plan_server_eligibility(server_id, plan_id);

COMMIT;
