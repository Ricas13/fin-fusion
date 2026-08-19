DO $$
BEGIN
  -- This typo repair is only relevant to databases that already contain the
  -- affected catalogue/billing tables. Clean-install baseline databases have
  -- the corrected spelling, and partial legacy databases may have none of
  -- these application tables yet.
  IF to_regclass('public.plans') IS NOT NULL THEN
    UPDATE plans
    SET name = 'Stremio Monthly Addon',
        updated_at = NOW()
    WHERE name = 'Stremio Montly Addon';
  END IF;

  IF to_regclass('public.subscriptions') IS NOT NULL THEN
    UPDATE subscriptions
    SET plan_name_snapshot = 'Stremio Monthly Addon',
        updated_at = NOW()
    WHERE plan_name_snapshot = 'Stremio Montly Addon';

    UPDATE subscriptions
    SET commercial_snapshot = jsonb_set(commercial_snapshot, '{planName}', to_jsonb('Stremio Monthly Addon'::text), false),
        updated_at = NOW()
    WHERE commercial_snapshot IS NOT NULL
      AND commercial_snapshot ->> 'planName' = 'Stremio Montly Addon';
  END IF;

  IF to_regclass('public.billing_checkout_intents') IS NOT NULL THEN
    UPDATE billing_checkout_intents
    SET commercial_snapshot = jsonb_set(commercial_snapshot, '{planName}', to_jsonb('Stremio Monthly Addon'::text), false),
        updated_at = NOW()
    WHERE commercial_snapshot IS NOT NULL
      AND commercial_snapshot ->> 'planName' = 'Stremio Montly Addon';
  END IF;
END
$$;
