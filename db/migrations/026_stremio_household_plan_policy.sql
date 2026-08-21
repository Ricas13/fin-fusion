BEGIN;

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS stremio_household_network_limit INTEGER NOT NULL DEFAULT 1 CHECK (stremio_household_network_limit BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS stremio_ip_replacement_policy TEXT NOT NULL DEFAULT 'customer_cooldown' CHECK (stremio_ip_replacement_policy IN ('auto_inactive','customer_cooldown')),
  ADD COLUMN IF NOT EXISTS stremio_ip_replacement_cooldown_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (stremio_ip_replacement_cooldown_minutes BETWEEN 15 AND 1440);

-- Existing Stremio plans keep their current lease-driven replacement behaviour.
-- New plans use the safer customer-controlled 24-hour cooldown by default.
UPDATE plans
SET stremio_ip_replacement_policy='auto_inactive'
WHERE service_type IN ('stremio','bundle');

COMMIT;
