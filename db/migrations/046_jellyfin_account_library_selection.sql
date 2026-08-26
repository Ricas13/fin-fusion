CREATE TABLE IF NOT EXISTS customer_jellyfin_library_selection (
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    jellyfin_account_id uuid NOT NULL REFERENCES jellyfin_accounts(id) ON DELETE CASCADE,
    selected_names text[] NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, jellyfin_account_id)
);

CREATE INDEX IF NOT EXISTS customer_jellyfin_library_selection_account_idx
    ON customer_jellyfin_library_selection(jellyfin_account_id);

-- Preserve existing customer-wide choices for every Jellyfin account. New
-- edits are account scoped, while the legacy row remains as a compatibility
-- fallback for accounts created before the customer next saves a selection.
INSERT INTO customer_jellyfin_library_selection(customer_id,jellyfin_account_id,selected_names,updated_at)
SELECT cls.customer_id, ja.id, cls.selected_names, cls.updated_at
FROM customer_library_selection cls
JOIN jellyfin_accounts ja
  ON ja.customer_id=cls.customer_id
 AND ja.account_purpose='jellyfin'
ON CONFLICT (customer_id,jellyfin_account_id) DO NOTHING;

COMMENT ON TABLE customer_jellyfin_library_selection IS
'Customer-selected Jellyfin libraries scoped to one Jellyfin account/server lane.';
