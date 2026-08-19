UPDATE plans
SET name = 'Stremio Monthly Addon',
    updated_at = NOW()
WHERE name = 'Stremio Montly Addon';

UPDATE subscriptions
SET plan_name_snapshot = 'Stremio Monthly Addon',
    updated_at = NOW()
WHERE plan_name_snapshot = 'Stremio Montly Addon';

UPDATE subscriptions
SET commercial_snapshot = jsonb_set(commercial_snapshot, '{planName}', to_jsonb('Stremio Monthly Addon'::text), false),
    updated_at = NOW()
WHERE commercial_snapshot IS NOT NULL
  AND commercial_snapshot ->> 'planName' = 'Stremio Montly Addon';

UPDATE billing_checkout_intents
SET commercial_snapshot = jsonb_set(commercial_snapshot, '{planName}', to_jsonb('Stremio Monthly Addon'::text), false),
    updated_at = NOW()
WHERE commercial_snapshot IS NOT NULL
  AND commercial_snapshot ->> 'planName' = 'Stremio Montly Addon';
