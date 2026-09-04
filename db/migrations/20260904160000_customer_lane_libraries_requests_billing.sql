BEGIN;

-- Library overrides were never lane-scoped, unlike technical policy overrides
-- (customer_lane_policy_overrides, migration 099). A customer holding both a
-- Free Server and a Premium Jellyfin entitlement could only ever have one set
-- of library grants, silently shared across both lanes. Add access_lane and
-- re-key the primary key to (customer_id, library_name, access_lane),
-- backfilling every existing row into the 'primary' lane (matching how
-- migration 099 backfilled customer_lane_policy_overrides).

ALTER TABLE public.customer_library_overrides
    ADD COLUMN IF NOT EXISTS access_lane text;

UPDATE public.customer_library_overrides SET access_lane='primary' WHERE access_lane IS NULL;

ALTER TABLE public.customer_library_overrides
    ALTER COLUMN access_lane SET NOT NULL,
    ALTER COLUMN access_lane SET DEFAULT 'primary';

ALTER TABLE public.customer_library_overrides
    DROP CONSTRAINT IF EXISTS customer_library_overrides_pkey;

ALTER TABLE public.customer_library_overrides
    ADD CONSTRAINT customer_library_overrides_pkey PRIMARY KEY (customer_id, library_name, access_lane);

ALTER TABLE public.customer_library_overrides
    DROP CONSTRAINT IF EXISTS customer_library_overrides_lane_check;
ALTER TABLE public.customer_library_overrides
    ADD CONSTRAINT customer_library_overrides_lane_check CHECK (access_lane IN ('primary','free'));

-- Per-customer override of the plan default Jellyseerr/Overseerr request
-- permission mask. NULL permission_mask means "no override, inherit the
-- plan"; a concrete mask is the full 23-bit resulting state once an admin
-- has touched any single permission (mirrors the existing managed/unmanaged
-- bulk permission grid pattern in admin-request-users.js). Scoped per
-- customer, not per lane: there is one external Jellyseerr identity per
-- customer today regardless of how many Jellyfin lanes they hold.
CREATE TABLE IF NOT EXISTS customer_request_permission_overrides (
    customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    permission_mask bigint,
    updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- Manual/off-platform payment ledger. Deliberately a pure audit record: it
-- does not touch subscription/expiry state. An admin still uses the existing
-- "Change expiry"/"Change plan" actions if the payment should grant access.
CREATE TABLE IF NOT EXISTS manual_payment_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    currency text NOT NULL,
    method text NOT NULL CHECK (method IN ('cash','bank_transfer','crypto','other')),
    note text,
    recorded_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS manual_payment_events_customer_idx ON manual_payment_events(customer_id, created_at DESC);

COMMIT;
