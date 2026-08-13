BEGIN;

INSERT INTO platform_settings(setting_key,setting_value)
VALUES
  ('account_policy', jsonb_build_object(
      'publicRegistration', false,
      'requireEmailVerification', false,
      'allowSelfServiceTrial', true
  )),
  ('reseller_defaults', jsonb_build_object(
      'credits', 0,
      'trialCredits', 0
  ))
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;