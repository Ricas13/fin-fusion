BEGIN;

-- Phase 3C: plan-based Jellyfin policy gains two more directly-configurable
-- fields (remuxing and remote access were previously implicit/hardcoded in
-- provisioning.js). Additive only -- existing plans keep working, remuxing
-- defaults to following video transcoding (its previous implicit behaviour)
-- and remote access defaults to on (its previous hardcoded behaviour).

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS allow_remuxing BOOLEAN,
    ADD COLUMN IF NOT EXISTS allow_remote_access BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE plans SET allow_remuxing = allow_video_transcoding WHERE allow_remuxing IS NULL;

ALTER TABLE plans ALTER COLUMN allow_remuxing SET NOT NULL;
ALTER TABLE plans ALTER COLUMN allow_remuxing SET DEFAULT FALSE;

-- Per-customer admin overrides of technical policy fields. A NULL column
-- means "inherit from plan" -- this is the whole mechanism for "Reset to
-- Plan": clear the column back to NULL rather than deleting/recreating rows,
-- so an empty override row (no columns set) is equivalent to no override
-- existing at all and is harmless to leave in place.
CREATE TABLE IF NOT EXISTS customer_policy_overrides (
    customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    streams INTEGER CHECK (streams IS NULL OR streams > 0),
    allow_downloads BOOLEAN,
    allow_video_transcoding BOOLEAN,
    allow_audio_transcoding BOOLEAN,
    allow_remuxing BOOLEAN,
    allow_live_tv BOOLEAN,
    allow_live_tv_management BOOLEAN,
    allow_remote_access BOOLEAN,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL
);

-- Per-library admin override of a customer's entitlement, granular per
-- library name (e.g. "grant this one customer 4K Movies although their plan
-- doesn't include it", or "revoke Anime for this one customer although
-- their plan includes it"). A row's absence for a given library means "no
-- override, inherit whatever the plan grants for that library". "Reset to
-- Plan" for a single library is just deleting its row -- it never touches
-- the plan. This is distinct from customer_library_selection below, which
-- is the customer's own deselection-only preference layered on top of
-- plan+override entitlement.
CREATE TABLE IF NOT EXISTS customer_library_overrides (
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    library_name TEXT NOT NULL,
    granted BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    PRIMARY KEY (customer_id, library_name)
);

-- Customer's own library visibility preference. Presence of a row means the
-- customer has recorded an explicit preference; absence means "no
-- preference recorded yet" and the customer sees their full entitlement.
-- selected_names is always intersected with the server-computed entitlement
-- at apply time -- it is never trusted as authoritative on its own, so a
-- stale or manipulated row can only ever narrow access, never widen it.
CREATE TABLE IF NOT EXISTS customer_library_selection (
    customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    selected_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
