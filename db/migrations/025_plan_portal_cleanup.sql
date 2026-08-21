BEGIN;

-- Bundles/add-ons remain in the database for historical subscription snapshots,
-- but they should no longer be offered as storefront catalogue products.
UPDATE plans
SET visible=FALSE, updated_at=NOW()
WHERE archived_at IS NULL
  AND visible=TRUE
  AND (COALESCE(is_addon,FALSE)=TRUE OR service_type='bundle');

-- Normalize previously saved Commerce dashboard layouts so the revenue KPI row
-- uses four compact cards instead of the older two-column layout.
UPDATE admin_dashboard_widget_layout
SET position=CASE widget_key
    WHEN 'mrr' THEN 1
    WHEN 'grossRevenue' THEN 2
    WHEN 'netRevenue' THEN 3
    WHEN 'payingCustomersArpu' THEN 4
    ELSE position
  END,
  span=3,
  updated_at=NOW()
WHERE dashboard_key='commerce'
  AND widget_key IN ('mrr','grossRevenue','netRevenue','payingCustomersArpu');

COMMIT;
