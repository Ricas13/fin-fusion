BEGIN;

-- Managed Jellyfin identities are binary: present and active while access is
-- valid, otherwise deleted. Remove the retired post-disable retention knobs
-- from persisted settings so old values cannot reappear in operator tooling.
UPDATE platform_settings
SET setting_value =
      COALESCE(setting_value, '{}'::jsonb)
      - 'freeDeleteAfterDisableDays'
      - 'trialDeleteAfterDisableDays'
      - 'paidDeleteAfterDisableDays'
      - 'deleteAfterDisableDays',
    updated_at = NOW()
WHERE setting_key = 'jellyfin_lifecycle_policy_v2'
  AND (
    setting_value ? 'freeDeleteAfterDisableDays'
    OR setting_value ? 'trialDeleteAfterDisableDays'
    OR setting_value ? 'paidDeleteAfterDisableDays'
    OR setting_value ? 'deleteAfterDisableDays'
  );

-- Keep any existing Free inactivity thresholds for backwards-compatible
-- enforcement, but remove stale disabled-account action/timing metadata.
UPDATE plans
SET inactivity_policy =
      COALESCE(inactivity_policy, '{}'::jsonb)
      - 'deleteAfterDisableDays'
      - 'action',
    updated_at = NOW()
WHERE COALESCE(service_type, 'jellyfin') IN ('jellyfin', 'bundle')
  AND (
    COALESCE(inactivity_policy, '{}'::jsonb) ? 'deleteAfterDisableDays'
    OR COALESCE(inactivity_policy, '{}'::jsonb) ? 'action'
  );

COMMIT;
