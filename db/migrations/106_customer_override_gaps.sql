BEGIN;

ALTER TABLE customer_policy_overrides
    ADD COLUMN IF NOT EXISTS allow_subtitle_editing boolean;
ALTER TABLE customer_lane_policy_overrides
    ADD COLUMN IF NOT EXISTS allow_subtitle_editing boolean;

CREATE TABLE IF NOT EXISTS customer_household_overrides (
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    service text NOT NULL,
    network_limit integer,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    PRIMARY KEY (customer_id, service),
    CONSTRAINT customer_household_overrides_service_check
        CHECK (service IN ('jellyfin', 'stremio')),
    CONSTRAINT customer_household_overrides_network_limit_check
        CHECK (network_limit IS NULL OR network_limit BETWEEN 1 AND 10)
);

COMMIT;
